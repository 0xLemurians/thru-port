import {
  BlockView,
  ConsensusStatus,
  PageRequest,
  TransactionView,
  type Transaction,
  type TransactionList,
} from "@thru/sdk";
import { BOOTSTRAP_FAUCET_VAULT_ADDRESS, BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { thru } from "./client";

export const ACTIVITY_PAGE_SIZE = 6;

export interface ActivityEntry {
  signature: string;
  type: string;
  status: string;
  timestampMs: number | null;
  slot: bigint | null;
  direction: "incoming" | "outgoing" | null;
  amount: string | null;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  nextPageToken: string | null;
}

/** Only read methods are accepted here; this module cannot submit or sign. */
export interface ActivityReader {
  listForAccount: (address: string, options: {
    page: PageRequest;
    transactionOptions: { view: TransactionView; minConsensus: ConsensusStatus };
  }) => Promise<TransactionList>;
  getBlock: (slot: bigint) => Promise<{
    slot: bigint;
    timestampNs?: bigint;
    consensusStatus?: ConsensusStatus;
  }>;
}

const defaultReader: ActivityReader = {
  listForAccount: (address, options) => thru.transactions.listForAccount(address, options),
  getBlock: async (slot) => {
    const block = await thru.blocks.get({ slot }, { view: BlockView.HEADER_ONLY });
    return {
      slot: block.header.slot,
      timestampNs: block.blockTimeNs,
      consensusStatus: block.consensusStatus,
    };
  },
};

function accountAt(transaction: Transaction, index: number): string | null {
  if (index === 0) return transaction.feePayer.toThruFmt();
  if (index === 1) return transaction.program.toThruFmt();
  const offset = index - 2;
  return (
    transaction.readWriteAccounts[offset] ??
    transaction.readOnlyAccounts[offset - transaction.readWriteAccounts.length]
  )?.toThruFmt() ?? null;
}

function classify(transaction: Transaction, walletAddress: string): Pick<ActivityEntry, "type" | "direction" | "amount"> {
  const neutral = { type: "Transaction", direction: null, amount: null } as const;
  const program = transaction.program.toThruFmt();
  const data = transaction.instructionData;

  if (
    program === BOOTSTRAP_PROGRAM_ADDRESSES.noop &&
    transaction.feePayer.toThruFmt() === walletAddress &&
    transaction.feePayerStateProof?.length &&
    (!data || data.length === 0) &&
    transaction.readWriteAccounts.length === 0 &&
    transaction.readOnlyAccounts.length === 0
  ) {
    return { type: "Account Creation", direction: null, amount: null };
  }

  if (program === BOOTSTRAP_PROGRAM_ADDRESSES.faucet && data?.length === 16) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const vaultIndex = view.getUint16(4, true);
    const recipientIndex = view.getUint16(6, true);
    if (
      view.getUint32(0, true) === 1 &&
      accountAt(transaction, vaultIndex) === BOOTSTRAP_FAUCET_VAULT_ADDRESS &&
      accountAt(transaction, recipientIndex) === walletAddress
    ) {
      return {
        type: "Faucet Funding",
        direction: "incoming",
        amount: `${view.getBigUint64(8, true).toString()} raw native units`,
      };
    }
  }

  if (program === BOOTSTRAP_PROGRAM_ADDRESSES.token && data && data.length > 0) {
    // Official TokenInstruction tag is the first byte. Fixed-size variants are
    // classified only when their complete payload and account indices validate.
    if (data[0] === 0 && data.length > 4) return { ...neutral, type: "Token Creation" };
    if (data[0] === 1 && data.length > 4) return { ...neutral, type: "Token Account Initialization" };
    if ((data[0] === 2 && data.length === 13) || (data[0] === 3 && data.length === 15)) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const first = view.getUint16(1, true);
      const second = view.getUint16(3, true);
      const third = data[0] === 3 ? view.getUint16(5, true) : null;
      if (accountAt(transaction, first) && accountAt(transaction, second) && (third === null || accountAt(transaction, third))) {
        return {
          type: data[0] === 2 ? "Token Transfer" : "Token Mint",
          direction: null, // Token-account ownership is not encoded in the instruction.
          amount: `${view.getBigUint64(data[0] === 2 ? 5 : 7, true).toString()} raw token units`,
        };
      }
    }
  }

  return neutral;
}

export function activityStatus(
  transaction: Transaction,
  consensusStatus?: ConsensusStatus,
): string {
  const result = transaction.executionResult;
  if (result && (result.vmError !== 0 || result.userErrorCode !== 0n)) return "Failed";
  switch (consensusStatus) {
    case ConsensusStatus.FINALIZED: return result ? "Finalized" : "Finality reported";
    case ConsensusStatus.CLUSTER_EXECUTED: return result ? "Cluster executed" : "Cluster status reported";
    case ConsensusStatus.LOCALLY_EXECUTED: return "Locally executed";
    case ConsensusStatus.INCLUDED: return "Included · not final";
    case ConsensusStatus.OBSERVED: return "Observed";
    default: return "Status unavailable";
  }
}

export function blockTimestampMs(timestampNs?: bigint): number | null {
  if (timestampNs === undefined || timestampNs <= 0n) return null;
  const millis = timestampNs / 1_000_000n;
  if (millis > 8_640_000_000_000_000n) return null;
  const value = Number(millis);
  return Number.isFinite(value) ? value : null;
}

export function uniqueActivityEntries(existing: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set(existing.map((entry) => entry.signature));
  return [...existing, ...incoming.filter((entry) => {
    if (seen.has(entry.signature)) return false;
    seen.add(entry.signature);
    return true;
  })];
}

export class ActivityRequestSequence {
  private generation = 0;

  begin(): number { return ++this.generation; }
  invalidate(): void { this.generation += 1; }
  isCurrent(generation: number): boolean { return generation === this.generation; }
}

function awaitRead<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Activity read stopped", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function loadActivityPage(
  walletAddress: string,
  pageToken: string | null = null,
  reader: ActivityReader = defaultReader,
  signal?: AbortSignal,
): Promise<ActivityPage> {
  signal?.throwIfAborted();
  const result = await awaitRead(reader.listForAccount(walletAddress, {
    page: new PageRequest({ pageSize: ACTIVITY_PAGE_SIZE, pageToken: pageToken ?? undefined }),
    transactionOptions: { view: TransactionView.FULL, minConsensus: ConsensusStatus.INCLUDED },
  }), signal);
  signal?.throwIfAborted();

  const slots = [...new Set(result.transactions.flatMap((tx) => tx.slot === undefined ? [] : [tx.slot]))];
  const blockResults = await awaitRead(Promise.allSettled(slots.map((slot) => reader.getBlock(slot))), signal);
  signal?.throwIfAborted();
  const blocks = new Map<bigint, Awaited<ReturnType<ActivityReader["getBlock"]>>>();
  blockResults.forEach((item, index) => {
    if (item.status === "fulfilled" && item.value.slot === slots[index]) blocks.set(slots[index], item.value);
  });

  const entries: ActivityEntry[] = [];
  for (const transaction of result.transactions) {
    const signature = transaction.getSignature()?.toThruFmt();
    if (!signature) continue;
    const block = transaction.slot === undefined ? undefined : blocks.get(transaction.slot);
    entries.push({
      signature,
      ...classify(transaction, walletAddress),
      status: activityStatus(transaction, block?.consensusStatus),
      timestampMs: blockTimestampMs(block?.timestampNs),
      slot: transaction.slot ?? null,
    });
  }
  return {
    entries: uniqueActivityEntries([], entries),
    nextPageToken: result.page?.nextPageToken || null,
  };
}
