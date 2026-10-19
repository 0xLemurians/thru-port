// OFFLINE Phase 5C boundary. The identities and signatures are synthetic public
// fixtures; no valid private key exists in this fixture and no signer is called.
import {
  Account, ConsensusStatus, Pubkey, Signature, Transaction, TransactionBuilder,
  TransactionSigningScheme, createThruClient, type BuildTransactionOptions,
} from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { TokenAccount, TokenMintAccount, TransferInstruction, deriveTokenAccountAddress } from "@thru/programs/token";
import type { ThruAccount } from "../../lib/wallet/thru-wallet";

export type TokenSendTransportMode = "success" | "missingdest" | "uncertaininit" |
  "transientnotfound" | "sendlost" | "signaturemismatch" | "vmfailure" |
  "includedonly" | "postmismatch" | "hungsend" | "hungstatus" |
  "statusunavailable" | "staleevidence";
export type TokenSendTransportStage = "read" | "build" | "sign" | "send" | "status";
export interface TokenSendTransportConfig {
  mode: TokenSendTransportMode;
  destinationExists: boolean;
  sourceViolation: "none" | "wrong-owner" | "wrong-program" | "wrong-mint" |
    "wrong-address" | "frozen" | "missing";
  sourceRaw: string;
  sourceBRaw: string;
  destinationRaw: string;
  pointConsensus: ConsensusStatus;
  statusNotFoundCount: number;
  chainId: number;
  startSlot: string;
}
export interface TokenSendTransportStats {
  build: number; sign: number; send: number; status: number; getStatus: number;
  accountGets: number; proofs: number; history: number; inventory: number;
  forbidden: number; events: string[]; sendTypes: ("initialize-account" | "transfer")[];
  durabilityAtSend: { journal: boolean; fence: boolean }[];
}

const address = (value: number) => Pubkey.from(new Uint8Array(32).fill(value)).toThruFmt();
const defaults: TokenSendTransportConfig = {
  mode: "success", destinationExists: true, sourceViolation: "none",
  sourceRaw: "125", sourceBRaw: "350", destinationRaw: "10",
  pointConsensus: ConsensusStatus.FINALIZED, statusNotFoundCount: 3,
  chainId: 2, startSlot: "100",
};
const emptyStats = (): TokenSendTransportStats => ({
  build: 0, sign: 0, send: 0, status: 0, getStatus: 0, accountGets: 0,
  proofs: 0, history: 0, inventory: 0, forbidden: 0, events: [],
  sendTypes: [], durabilityAtSend: [],
});
const absent = (): never => { throw Object.assign(new Error("[not_found] synthetic fixture absent"), { code: 5 }); };
const never = () => new Promise<never>(() => {});

export function createTokenSendTransport() {
  // Creating the SDK object does not contact its transport. Every impure method
  // is replaced below before this client is exposed; pure address helpers stay real.
  const client = createThruClient({ baseUrl: "http://phase5c.invalid",
    transactionSigningScheme: TransactionSigningScheme.Rfc8032 });
  const ids = {
    walletA: address(101), walletB: address(102), recipient: address(103),
    mint: address(104), sourceA: address(105), sourceB: address(106),
    sourceWalletB: address(107), destination: "", otherMint: address(108), outsider: address(109),
  };
  ids.destination = deriveTokenAccountAddress(client, ids.recipient, ids.mint,
    BOOTSTRAP_PROGRAM_ADDRESSES.token, new Uint8Array(32)).address;
  const accountA: ThruAccount = { address: ids.walletA,
    publicKey: Pubkey.from(ids.walletA).toBytes(), privateKey: new Uint8Array() };
  const accountB: ThruAccount = { address: ids.walletB,
    publicKey: Pubkey.from(ids.walletB).toBytes(), privateKey: new Uint8Array() };
  let config = { ...defaults };
  let counters = emptyStats();
  let sourceRaw = 125n, sourceBRaw = 350n, destinationRaw = 10n;
  let destinationExists = true;
  let ordinal = 0;
  const pending = new Map<string, { transaction: Transaction; polls: number; applied: boolean }>();
  const remoteEvidence = new Map<string, "success" | "failure">();
  const held = new Set<TokenSendTransportStage>();
  const releases = new Map<TokenSendTransportStage, (() => void)[]>();
  const event = (value: string) => { counters.events.push(value); };
  const boundary = async (stage: TokenSendTransportStage) => {
    if (held.has(stage)) await new Promise<void>((resolve) => {
      releases.set(stage, [...(releases.get(stage) ?? []), resolve]);
    });
  };
  const deny = (): never => { counters.forbidden++; throw new Error("Phase 5C denies live transport, real signing and wallet generation"); };
  // Keep only inert helpers. Unsupported SDK calls cannot accidentally reach RPC.
  for (const sdkModule of [client.accounts, client.transactions, client.proofs,
    client.keys, client.blocks, client.version, client.chain, client.events,
    client.node, client.slots, client.nonce, client.compression]) {
    for (const name of Object.keys(sdkModule)) {
      if (typeof Reflect.get(sdkModule, name) === "function") {
        Object.defineProperty(sdkModule, name, { configurable: true, value: deny });
      }
    }
  }
  const replace = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { configurable: true, value });
  const flags = { isProgram: false, isPrivileged: false, isUncompressable: false,
    isEphemeral: false, isDeleted: false, isNew: false, isCompressed: false };
  function envelope(publicAddress: string, data: Uint8Array, owner = BOOTSTRAP_PROGRAM_ADDRESSES.token,
    consensus = config.pointConsensus): Account {
    return new Account({ address: Pubkey.from(publicAddress),
      meta: { version: 1, flags, owner: Pubkey.from(owner), dataSize: data.length,
        seq: 1n, nonce: 1n, balance: 10000n }, data: { data, compressed: false },
      consensusStatus: consensus, versionContext: { slot: 100n, seq: 1n } });
  }
  function token(publicAddress: string, wallet: string, raw: bigint,
    violation: TokenSendTransportConfig["sourceViolation"] = "none") {
    if (violation === "missing") return absent();
    const data = TokenAccount.builder().set_mint(Pubkey.from(violation === "wrong-mint" ? ids.otherMint : ids.mint).toBytes())
      .set_owner(Pubkey.from(violation === "wrong-owner" ? ids.outsider : wallet).toBytes())
      .set_amount(raw).set_is_frozen(violation === "frozen" ? 1 : 0).build();
    return envelope(violation === "wrong-address" ? ids.outsider : publicAddress, data,
      violation === "wrong-program" ? ids.outsider : BOOTSTRAP_PROGRAM_ADDRESSES.token);
  }
  function mint(): Account {
    const ticker = new Uint8Array(9); ticker.set([3, 81, 65, 84]);
    return envelope(ids.mint, TokenMintAccount.builder().set_decimals(2).set_supply(1000n)
      .set_creator(Pubkey.from(ids.walletA).toBytes()).set_mint_authority(Pubkey.from(ids.walletA).toBytes())
      .set_freeze_authority(new Uint8Array(32)).set_has_freeze_authority(0).set_ticker(ticker).build());
  }
  function lookup(publicAddress: string): Account {
    if ([ids.walletA, ids.walletB, ids.recipient].includes(publicAddress)) {
      return envelope(publicAddress, new Uint8Array(), BOOTSTRAP_PROGRAM_ADDRESSES.eoa);
    }
    if (publicAddress === ids.mint || publicAddress === ids.otherMint) return mint();
    if (publicAddress === ids.sourceA) return token(publicAddress, ids.walletA, sourceRaw, config.sourceViolation);
    if (publicAddress === ids.sourceB) return token(publicAddress, ids.walletA, sourceBRaw, config.sourceViolation);
    if (publicAddress === ids.sourceWalletB) return token(publicAddress, ids.walletB, 200n, config.sourceViolation);
    if (publicAddress === ids.destination && destinationExists) return token(publicAddress, ids.recipient, destinationRaw);
    return absent();
  }
  replace(client.accounts, "get", async (input: Parameters<typeof Pubkey.from>[0]) => {
    counters.accountGets++; event("read:start"); await boundary("read");
    const result = lookup(Pubkey.from(input).toThruFmt()); event("read:complete"); return result;
  });
  replace(client.accounts, "list", async () => {
    counters.inventory++;
    return { accounts: [lookup(ids.sourceA), lookup(ids.sourceB), lookup(ids.sourceWalletB)] };
  });
  replace(client.transactions, "listForAccount", async () => { counters.history++; return { transactions: [] }; });
  replace(client.blocks, "getBlockHeight", async () => ({ finalized: 100n, locallyExecuted: 101n, clusterExecuted: 101n }));
  replace(client.chain, "getChainId", async () => config.chainId);
  replace(client.chain, "getChainInfo", async () => ({ chainId: config.chainId }));
  replace(client.proofs, "generate", async () => {
    counters.proofs++; event("proof");
    // Structurally valid synthetic CREATION proof, not a genuine state proof.
    // The official ABI builder validates its layout; no node ever receives it.
    const proof = new Uint8Array(104);
    new DataView(proof.buffer).setBigUint64(0, (2n << 62n) | 100n, true);
    return { proof, slot: 100n };
  });
  replace(client.transactions, "build", async (options: BuildTransactionOptions): Promise<Transaction> => {
    counters.build++; event("build:start"); await boundary("build");
    const header = { fee: 0n, nonce: 1n, startSlot: BigInt(config.startSlot), chainId: config.chainId,
      ...options.header };
    const builder = new TransactionBuilder();
    const accounts = { readWriteAccounts: options.accounts?.readWrite,
      readOnlyAccounts: options.accounts?.readOnly };
    const base = builder.build({ feePayer: options.feePayer, program: options.program, header, accounts });
    const ordered = [base.feePayer, base.program, ...base.readWriteAccounts, ...base.readOnlyAccounts];
    const instructionData = typeof options.instructionData === "function"
      ? await options.instructionData({ accounts: ordered, getAccountIndex(input) {
        const expected = Pubkey.from(input).toThruFmt();
        const index = ordered.findIndex((key) => key.toThruFmt() === expected);
        if (index < 0) throw new Error("Synthetic build references an absent account");
        return index;
      } }) : options.instructionData;
    const transaction = builder.build({ feePayer: options.feePayer, program: options.program,
      header, accounts, instructionData });
    replace(transaction, "sign", async () => {
      counters.sign++; event("sign:start"); await boundary("sign");
      const bytes = new Uint8Array(64); bytes.fill(120); new DataView(bytes.buffer).setUint32(0, ++ordinal, true);
      const signature = Signature.from(bytes); transaction.setSignature(signature); event("sign:complete");
      return signature;
    });
    event("build:complete"); return transaction;
  });
  const kindOf = (transaction: Transaction): "initialize-account" | "transfer" => {
    const tag = transaction.instructionData?.[0];
    if (tag === 1) return "initialize-account";
    if (tag === 2) return "transfer";
    throw new Error("Unexpected synthetic token instruction");
  };
  function apply(transaction: Transaction) {
    if (config.mode === "postmismatch") return;
    if (kindOf(transaction) === "initialize-account") { destinationExists = true; destinationRaw = 0n; return; }
    const payload = transaction.instructionData?.subarray(1);
    const transfer = payload ? TransferInstruction.from_array(payload) : null;
    if (!transfer) throw new Error("Synthetic transfer payload is malformed");
    const all = [transaction.feePayer, transaction.program, ...transaction.readWriteAccounts, ...transaction.readOnlyAccounts];
    const source = all[transfer.get_source_account_index()]?.toThruFmt();
    const destination = all[transfer.get_dest_account_index()]?.toThruFmt();
    if (destination !== ids.destination) throw new Error("Synthetic destination mismatch");
    if (source === ids.sourceA) sourceRaw -= transfer.get_amount();
    else if (source === ids.sourceB) sourceBRaw -= transfer.get_amount();
    else if (source !== ids.sourceWalletB) throw new Error("Synthetic source mismatch");
    destinationRaw += transfer.get_amount();
  }
  function durableAtSend(wallet: string, signature: string) {
    let journal = false, fence = false;
    try {
      const raw = localStorage.getItem("thru.tokenStudio.pendingOperations.betanet:2.v1");
      const records: unknown = raw === null ? [] : JSON.parse(raw);
      journal = Array.isArray(records) && records.some((record: unknown) => {
        if (!record || typeof record !== "object") return false;
        const candidate = record as Record<string, unknown>;
        return candidate.signature === signature && candidate.walletAddress === wallet;
      });
      const encoded = localStorage.getItem(`thru.writeFence.betanet:2.v1.${wallet}`);
      const candidate: unknown = encoded ? JSON.parse(encoded) : null;
      fence = !!candidate && typeof candidate === "object" &&
        Reflect.get(candidate, "signature") === signature && Reflect.get(candidate, "wallet") === wallet;
    } catch { /* Record the observed failure, never veto/mask production behavior. */ }
    counters.durabilityAtSend.push({ journal, fence });
  }
  replace(client.transactions, "send", async (wire: Uint8Array) => {
    counters.send++; event("send:start");
    const transaction = Transaction.fromWire(wire);
    const signature = transaction.getSignature()?.toThruFmt();
    if (!signature) throw new Error("Synthetic signed transaction missing signature");
    counters.sendTypes.push(kindOf(transaction));
    durableAtSend(transaction.feePayer.toThruFmt(), signature);
    pending.set(signature, { transaction, polls: 0, applied: false });
    await boundary("send");
    if (config.mode === "hungsend") return never();
    if (config.mode === "sendlost") throw new Error("Synthetic accepted response lost");
    if (config.mode === "signaturemismatch") return Signature.from(new Uint8Array(64).fill(119)).toThruFmt();
    event("send:complete"); return signature;
  });
  const execution = (failed = false) => ({ consumedComputeUnits: 0, consumedMemoryUnits: 0,
    consumedStateUnits: 0, userErrorCode: failed ? 9n : 0n, vmError: failed ? 7 : 0,
    executionResult: 0n, pagesUsed: 0, eventsCount: 0, eventsSize: 0,
    readwriteAccounts: [], readonlyAccounts: [], errorProgramAccIdx: 0 });
  replace(client.transactions, "getStatus", async (input: Parameters<typeof Signature.from>[0]) => {
    counters.status++; counters.getStatus++; event("status:start"); await boundary("status");
    if (config.mode === "hungstatus") return never();
    const signature = Signature.from(input), entry = pending.get(signature.toThruFmt());
    if (!entry) {
      const evidence = remoteEvidence.get(signature.toThruFmt());
      if (!evidence) return absent();
      event("status:remote-evidence");
      return { signature: signature.toBytes(), statusCode: ConsensusStatus.CLUSTER_EXECUTED,
        executionResult: execution(evidence === "failure") };
    }
    entry.polls++;
    if (config.mode === "statusunavailable") throw new Error("Synthetic status unavailable");
    if (config.mode === "transientnotfound" && entry.polls <= config.statusNotFoundCount) return absent();
    const provisional = config.mode === "includedonly" ||
      (config.mode === "uncertaininit" && kindOf(entry.transaction) === "initialize-account");
    const failed = config.mode === "vmfailure";
    if (!provisional && !failed && !entry.applied) { apply(entry.transaction); entry.applied = true; }
    event("status:complete");
    const staleFirst = config.mode === "staleevidence" && entry.polls === 1;
    return { signature: signature.toBytes(), statusCode: provisional || staleFirst ? ConsensusStatus.INCLUDED : ConsensusStatus.CLUSTER_EXECUTED,
      ...(config.mode === "staleevidence" && entry.polls > 1 ? {} : { executionResult: execution(failed) }) };
  });
  replace(client.transactions, "get", async (input: Parameters<typeof Signature.from>[0]) => {
    event("finalized-read");
    const signature = Signature.from(input), entry = pending.get(signature.toThruFmt());
    if (!entry) {
      const evidence = remoteEvidence.get(signature.toThruFmt());
      return evidence ? { executionResult: execution(evidence === "failure") } : absent();
    }
    if (!entry || ["includedonly", "uncertaininit", "statusunavailable", "sendlost"].includes(config.mode)) return absent();
    return { executionResult: execution(config.mode === "vmfailure") };
  });
  const configure = (next: Partial<TokenSendTransportConfig>) => {
    config = { ...config, ...next };
    if (next.sourceRaw !== undefined) sourceRaw = BigInt(next.sourceRaw);
    if (next.sourceBRaw !== undefined) sourceBRaw = BigInt(next.sourceBRaw);
    if (next.destinationRaw !== undefined) destinationRaw = BigInt(next.destinationRaw);
    if (next.destinationExists !== undefined) destinationExists = next.destinationExists;
    if (next.mode === "missingdest" || next.mode === "uncertaininit") destinationExists = false;
  };
  const release = (stage: TokenSendTransportStage) => {
    held.delete(stage); const waiting = releases.get(stage) ?? [];
    releases.delete(stage); waiting.forEach((resolve) => resolve());
  };
  return {
    client, ids, accountA, accountB, configure,
    evidence(signature: string, outcome: "success" | "failure"): void {
      remoteEvidence.set(Signature.from(signature).toThruFmt(), outcome);
    },
    reset() {
      for (const stage of held) release(stage);
      config = { ...defaults }; counters = emptyStats(); ordinal = 0; pending.clear(); remoteEvidence.clear();
      sourceRaw = 125n; sourceBRaw = 350n; destinationRaw = 10n; destinationExists = true;
    },
    hold(stage: TokenSendTransportStage) { held.add(stage); }, release,
    stats(): TokenSendTransportStats { return { ...counters, events: [...counters.events],
      sendTypes: [...counters.sendTypes], durabilityAtSend: counters.durabilityAtSend.map((entry) => ({ ...entry })) }; },
    snapshot() { return { sourceRaw: sourceRaw.toString(), sourceBRaw: sourceBRaw.toString(),
      destinationRaw: destinationRaw.toString(), destinationExists }; },
  };
}

export type TokenSendTransport = ReturnType<typeof createTokenSendTransport>;
