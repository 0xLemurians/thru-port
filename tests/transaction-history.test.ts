import test from "node:test";
import assert from "node:assert/strict";
import {
  ConsensusStatus,
  PageResponse,
  Pubkey,
  Signature,
  Transaction,
  TransactionView,
} from "@thru/sdk";
import { BOOTSTRAP_FAUCET_VAULT_ADDRESS, BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import {
  ACTIVITY_PAGE_SIZE,
  ActivityRequestSequence,
  activityStatus,
  blockTimestampMs,
  loadActivityPage,
  uniqueActivityEntries,
  type ActivityReader,
} from "../lib/thru/activity";
import { explorerTransactionUrl } from "../lib/thru/network";

const wallet = Pubkey.from(new Uint8Array(32).fill(7)).toThruFmt();
const other = Pubkey.from(new Uint8Array(32).fill(8)).toThruFmt();
const vault = Pubkey.from(new Uint8Array(32).fill(9)).toThruFmt();

function transaction(options: {
  program?: string;
  instructionData?: Uint8Array;
  readWrite?: string[];
  proof?: Uint8Array;
  signatureByte?: number;
  slot?: bigint;
  vmError?: number;
  userErrorCode?: bigint;
} = {}): Transaction {
  const tx = new Transaction({
    feePayer: wallet,
    program: options.program ?? BOOTSTRAP_PROGRAM_ADDRESSES.token,
    header: { fee: 0n, nonce: 0n, startSlot: 10n, chainId: 2 },
    accounts: { readWriteAccounts: options.readWrite ?? [] },
    instructionData: options.instructionData,
    proofs: options.proof ? { feePayerStateProof: options.proof } : undefined,
  });
  tx.setSignature(Signature.from(new Uint8Array(64).fill(options.signatureByte ?? 1)));
  tx.slot = options.slot ?? 11n;
  if (options.vmError !== undefined || options.userErrorCode !== undefined) {
    tx.executionResult = {
      consumedComputeUnits: 0,
      consumedMemoryUnits: 0,
      consumedStateUnits: 0,
      userErrorCode: options.userErrorCode ?? 0n,
      vmError: options.vmError ?? 0,
      executionResult: 0n,
      pagesUsed: 0,
      eventsCount: 0,
      eventsSize: 0,
      readwriteAccounts: [],
      readonlyAccounts: [],
      errorProgramAccIdx: 0,
    };
  }
  return tx;
}

function reader(transactions: Transaction[], nextPageToken?: string): ActivityReader {
  return {
    listForAccount: async () => ({ transactions, page: new PageResponse({ nextPageToken }) }),
    getBlock: async (slot) => ({ slot, timestampNs: 1_790_000_000_000_000_000n, consensusStatus: ConsensusStatus.FINALIZED }),
  };
}

function tokenData(tag: number, amount?: bigint): Uint8Array {
  const bytes = new Uint8Array(tag === 2 ? 13 : 15);
  const view = new DataView(bytes.buffer);
  bytes[0] = tag;
  view.setUint16(1, 2, true);
  view.setUint16(3, 3, true);
  if (tag === 3) view.setUint16(5, 0, true);
  view.setBigUint64(tag === 2 ? 5 : 7, amount ?? 0n, true);
  return bytes;
}

test("listForAccount requests bounded FULL transaction pages at INCLUDED minimum", async () => {
  let calls = 0;
  const mock: ActivityReader = {
    ...reader([]),
    listForAccount: async (address, options) => {
      calls += 1;
      assert.equal(address, wallet);
      assert.equal(options.page.pageSize, ACTIVITY_PAGE_SIZE);
      assert.equal(options.page.pageToken, "cursor-1");
      assert.equal(options.transactionOptions.view, TransactionView.FULL);
      assert.equal(options.transactionOptions.minConsensus, ConsensusStatus.INCLUDED);
      return { transactions: [], page: new PageResponse({ nextPageToken: "cursor-2" }) };
    },
  };
  const page = await loadActivityPage(wallet, "cursor-1", mock);
  assert.equal(calls, 1);
  assert.equal(page.nextPageToken, "cursor-2");
});

test("account creation is identified only with the wallet creation proof and empty NOOP body", async () => {
  const page = await loadActivityPage(wallet, null, reader([
    transaction({ program: BOOTSTRAP_PROGRAM_ADDRESSES.noop, proof: Uint8Array.of(1) }),
    transaction({ program: BOOTSTRAP_PROGRAM_ADDRESSES.noop, signatureByte: 2 }),
  ]));
  assert.equal(page.entries[0].type, "Account Creation");
  assert.equal(page.entries[1].type, "Transaction");
});

test("faucet funding decodes actual recipient and raw amount, not an unrelated recipient", async () => {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint16(4, 2, true);
  view.setUint16(6, 0, true);
  view.setBigUint64(8, 10_000n, true);
  const matched = await loadActivityPage(wallet, null, reader([
    transaction({ program: BOOTSTRAP_PROGRAM_ADDRESSES.faucet, instructionData: data, readWrite: [BOOTSTRAP_FAUCET_VAULT_ADDRESS] }),
  ]));
  assert.equal(matched.entries[0].type, "Faucet Funding");
  assert.equal(matched.entries[0].direction, "incoming");
  assert.equal(matched.entries[0].amount, "10000 raw native units");
  view.setUint16(6, 3, true);
  const unrelated = await loadActivityPage(wallet, null, reader([
    transaction({ program: BOOTSTRAP_PROGRAM_ADDRESSES.faucet, instructionData: data, readWrite: [BOOTSTRAP_FAUCET_VAULT_ADDRESS, other] }),
  ]));
  assert.equal(unrelated.entries[0].type, "Transaction");
});

test("token variants use the official program/tag and fixed amount payload without inventing direction", async () => {
  const page = await loadActivityPage(wallet, null, reader([
    transaction({ instructionData: Uint8Array.of(0, 1, 2, 3, 4), signatureByte: 1 }),
    transaction({ instructionData: Uint8Array.of(1, 1, 2, 3, 4), signatureByte: 2 }),
    transaction({ instructionData: tokenData(2, 99n), readWrite: [vault, other], signatureByte: 3 }),
    transaction({ instructionData: tokenData(3, 10n), readWrite: [vault, other], signatureByte: 4 }),
  ]));
  assert.deepEqual(page.entries.map((entry) => entry.type), [
    "Token Creation", "Token Account Initialization", "Token Transfer", "Token Mint",
  ]);
  assert.equal(page.entries[2].amount, "99 raw token units");
  assert.equal(page.entries[2].direction, null);
  assert.equal(page.entries[3].amount, "10 raw token units");
});

test("unknown programs and malformed token instructions remain neutral", async () => {
  const page = await loadActivityPage(wallet, null, reader([
    transaction({ program: other, instructionData: tokenData(2, 10n) }),
    transaction({ instructionData: Uint8Array.of(2, 0), signatureByte: 2 }),
  ]));
  assert.deepEqual(page.entries.map((entry) => entry.type), ["Transaction", "Transaction"]);
  assert.deepEqual(page.entries.map((entry) => entry.amount), [null, null]);
});

test("consensus and execution error mapping never promotes INCLUDED to finalized", () => {
  const success = transaction({ vmError: 0 });
  assert.equal(activityStatus(success, ConsensusStatus.INCLUDED), "Included · not final");
  assert.equal(activityStatus(success, ConsensusStatus.CLUSTER_EXECUTED), "Cluster executed");
  assert.equal(activityStatus(success, ConsensusStatus.FINALIZED), "Finalized");
  assert.equal(activityStatus(transaction({ vmError: 1 }), ConsensusStatus.FINALIZED), "Failed");
  assert.equal(activityStatus(transaction({ userErrorCode: 2n }), ConsensusStatus.FINALIZED), "Failed");
  assert.equal(activityStatus(transaction(), undefined), "Status unavailable");
});

test("block time is shown only when a valid block header timestamp exists", async () => {
  assert.equal(blockTimestampMs(undefined), null);
  assert.equal(blockTimestampMs(0n), null);
  const page = await loadActivityPage(wallet, null, reader([transaction()]));
  assert.equal(page.entries[0].timestampMs, 1_790_000_000_000);
  assert.equal(page.entries[0].status, "Finality reported");
});

test("missing block metadata does not prevent signature/history display", async () => {
  const mock: ActivityReader = { ...reader([transaction()]), getBlock: async () => { throw new Error("transport internals"); } };
  const page = await loadActivityPage(wallet, null, mock);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].timestampMs, null);
  assert.equal(page.entries[0].status, "Status unavailable");
});

test("duplicate signatures across and within pages appear only once", async () => {
  const page = await loadActivityPage(wallet, null, reader([transaction(), transaction()]));
  assert.equal(page.entries.length, 1);
  const duplicate = uniqueActivityEntries(page.entries, [...page.entries, {
    ...page.entries[0], signature: "new-signature",
  }]);
  assert.equal(duplicate.length, 2);
});

test("RPC failures reject without exposing internal text as an activity entry", async () => {
  const mock: ActivityReader = {
    ...reader([]),
    listForAccount: async () => { throw new Error("raw proxy connection details"); },
  };
  await assert.rejects(loadActivityPage(wallet, null, mock));
});

test("wallet-switch request generation invalidates stale asynchronous results", async () => {
  const sequence = new ActivityRequestSequence();
  const first = sequence.begin();
  let resolveOld!: (value: Awaited<ReturnType<ActivityReader["listForAccount"]>>) => void;
  const oldRead = new Promise<Awaited<ReturnType<ActivityReader["listForAccount"]>>>((resolve) => { resolveOld = resolve; });
  const oldPromise = loadActivityPage(wallet, null, { ...reader([]), listForAccount: () => oldRead });
  const second = sequence.begin();
  resolveOld({ transactions: [transaction()], page: new PageResponse() });
  const oldResult = await oldPromise;
  assert.equal(oldResult.entries.length, 1);
  assert.equal(sequence.isCurrent(first), false);
  assert.equal(sequence.isCurrent(second), true);
  sequence.invalidate();
  assert.equal(sequence.isCurrent(second), false);
});

test("aborting an in-flight read stops further block reads and never calls a write method", async () => {
  const abort = new AbortController();
  let resolveList!: (value: Awaited<ReturnType<ActivityReader["listForAccount"]>>) => void;
  let blockCalls = 0;
  const mock: ActivityReader = {
    listForAccount: () => new Promise((resolve) => { resolveList = resolve; }),
    getBlock: async (slot) => { blockCalls++; return { slot }; },
  };
  const pending = loadActivityPage(wallet, null, mock, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  resolveList({ transactions: [transaction()], page: new PageResponse() });
  await Promise.resolve();
  assert.equal(blockCalls, 0);
});

test("Explorer URLs are Betanet-scoped and encode untrusted signature text", () => {
  assert.equal(explorerTransactionUrl("thru-test"), "https://scan.thru.org/tx/thru-test?network=betanet");
  assert.equal(explorerTransactionUrl("x?evil=1"), "https://scan.thru.org/tx/x%3Fevil%3D1?network=betanet");
});
