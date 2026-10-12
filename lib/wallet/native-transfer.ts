import {
  ConsensusStatus, EOA_PROGRAM_ID, Signature, SignatureDomain, TransactionView,
  verifyWithDomain, type Account, type BuildTransactionOptions, type Transaction,
} from "@thru/sdk";
import { thru } from "../thru/client";
import { explorerTransactionUrl, THRU_NETWORK } from "../thru/network";
import { buildTransactionForSigning, signTransactionForSubmission, submitSignedTransactionOnce,
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE, type TransactionStatusLike } from "../thru/transactions";
import { clearWriteFence, withWalletWriteGuard, WriteOperationBlockedError, type WriteLockProvider } from "../thru/write-operation-guard";
import { assertAccountIdentity, type ThruAccount } from "./thru-wallet";
import { assertNativeEoa, buildNativeTransferInstruction, nativeTransferAddress,
  NativeTransferError, NATIVE_TRANSFER_HEADER, NATIVE_U64_MAX, parseNativeTransferAmount,
  validateNativeTransferBalances } from "./native-transfer-validation";
import { loadNativeTransfers, nativeJournalStorage, persistNativeTransfer, removeNativeTransfer,
  type NativeJournalStorage, type PendingNativeTransfer } from "./pending-native-transfer";

export interface NativeTransferDependencies {
  readAccount(address: string): Promise<Account>;
  chainId(): Promise<number>;
  finalizedSlot(): Promise<bigint>;
  build(options: BuildTransactionOptions): Promise<Transaction>;
  send(wire: Uint8Array): Promise<string>;
  status(signature: string): Promise<TransactionStatusLike>;
  transaction(signature: string): Promise<Transaction>;
  identity(account: ThruAccount): Promise<void>;
}
const production: NativeTransferDependencies = {
  readAccount: (address) => thru.accounts.get(address),
  chainId: () => thru.chain.getChainId(),
  finalizedSlot: async () => (await thru.blocks.getBlockHeight()).finalized,
  build: (options) => thru.transactions.build(options),
  send: (wire) => thru.transactions.send(wire),
  status: (signature) => thru.transactions.getStatus(signature),
  transaction: (signature) => thru.transactions.get(signature, {
    view: TransactionView.HEADER_AND_BODY, minConsensus: ConsensusStatus.CLUSTER_EXECUTED,
  }),
  identity: assertAccountIdentity,
};

export interface NativeTransferOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injection is for deterministic tests; production uses the central public SDK client. */
  dependencies?: NativeTransferDependencies;
  storage?: NativeJournalStorage;
  locks?: WriteLockProvider;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface NativeTransferResult {
  outcome: "success" | "failure" | "uncertain";
  signature: string;
  explorerUrl: string;
  message?: string;
  vmError?: number;
  userErrorCode?: bigint;
  persistenceWarning?: boolean;
}

function authoritative(status: TransactionStatusLike): boolean {
  return status.statusCode === ConsensusStatus.FINALIZED || status.statusCode === ConsensusStatus.CLUSTER_EXECUTED;
}
function validExecution(status: TransactionStatusLike): boolean {
  const execution = status.executionResult;
  return !!execution && Number.isSafeInteger(execution.vmError) && execution.vmError >= 0 &&
    typeof execution.userErrorCode === "bigint" && execution.userErrorCode >= 0n &&
    (execution.executionResult === undefined || typeof execution.executionResult === "bigint");
}
function failed(status: TransactionStatusLike): boolean {
  const execution = status.executionResult;
  return !!execution && (execution.vmError !== 0 || execution.userErrorCode !== 0n ||
    (execution.executionResult !== undefined && execution.executionResult !== 0n));
}

/** Bounds each in-flight RPC; late completions cannot sign, write state or submit. */
async function bounded<T>(work: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new NativeTransferError("ABORTED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new NativeTransferError("ABORTED");
        return work();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NativeTransferError("RPC_UNAVAILABLE")), timeoutMs);
        onAbort = () => reject(new NativeTransferError("ABORTED"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function bodyHash(transaction: Transaction): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(transaction.toWireForSigning()).buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertIntent(transaction: Transaction, intent: Pick<PendingNativeTransfer, "walletAddress" | "recipientAddress" | "amountRaw" | "nonce" | "startSlot">): void {
  const instruction = buildNativeTransferInstruction(BigInt(intent.amountRaw));
  if (transaction.feePayer.toThruFmt() !== intent.walletAddress || transaction.program.toThruFmt() !== EOA_PROGRAM_ID ||
      transaction.chainId !== THRU_NETWORK.expectedChainId || transaction.nonce !== BigInt(intent.nonce) ||
      transaction.startSlot !== BigInt(intent.startSlot) || transaction.version !== 1 ||
      transaction.fee !== NATIVE_TRANSFER_HEADER.fee || transaction.expiryAfter !== 100 || transaction.flags !== 0 ||
      transaction.requestedComputeUnits !== 10_000 || transaction.requestedStateUnits !== 0 || transaction.requestedMemoryUnits !== 10_000 ||
      transaction.readWriteAccounts.length !== 1 || transaction.readWriteAccounts[0].toThruFmt() !== intent.recipientAddress ||
      transaction.readOnlyAccounts.length !== 0 || transaction.feePayerStateProof?.length || transaction.feePayerAccountMetaRaw?.length ||
      transaction.instructionData?.length !== 16 || instruction.some((byte, index) => byte !== transaction.instructionData?.[index])) {
    throw new NativeTransferError("INVALID_TRANSACTION");
  }
}

async function verifyIntent(transaction: Transaction, record: PendingNativeTransfer): Promise<void> {
  assertIntent(transaction, record);
  if (transaction.getSignature()?.toThruFmt() !== record.signature || await bodyHash(transaction) !== record.bodyHash ||
      !await verifyWithDomain(Signature.from(record.signature).toBytes(), transaction.toWireForSigning(), transaction.feePayer.toBytes(), SignatureDomain.TXN)) {
    throw new NativeTransferError("INVALID_TRANSACTION");
  }
}

function settings(options: NativeTransferOptions) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (![timeoutMs, requestTimeoutMs, pollIntervalMs].every((value) => Number.isFinite(value) && value > 0)) throw new NativeTransferError("INVALID_CONTEXT");
  return { timeoutMs, requestTimeoutMs, pollIntervalMs, now: options.now ?? (() => performance.now()),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    dependencies: options.dependencies ?? production, storage: options.storage ?? nativeJournalStorage() };
}

function complete(record: PendingNativeTransfer, storage: NativeJournalStorage, outcome: NativeTransferResult["outcome"], status?: TransactionStatusLike): NativeTransferResult {
  const result: NativeTransferResult = { outcome, signature: record.signature, explorerUrl: explorerTransactionUrl(record.signature),
    ...(status?.executionResult ? { vmError: status.executionResult.vmError, userErrorCode: status.executionResult.userErrorCode } : {}),
    ...(outcome === "uncertain" ? { message: SAFE_TRANSACTION_UNCERTAIN_MESSAGE } : {}),
    ...(outcome === "failure" ? { message: "The native transfer was rejected during execution." } : {}),
  };
  try {
    if (outcome === "uncertain") persistNativeTransfer({ ...record, status: "uncertain" }, storage);
    else {
      removeNativeTransfer(record, storage);
      clearWriteFence(record.walletAddress, storage);
    }
  } catch { result.persistenceWarning = true; }
  return result;
}

/** Core only. Caller supplies the already-active wallet; no wallet generation, UI or auto-create. */
export async function transferNativeUnits(account: ThruAccount, recipientInput: string, amountInput: string, options: NativeTransferOptions = {}): Promise<NativeTransferResult> {
  const wallet = nativeTransferAddress(account.address);
  const recipient = nativeTransferAddress(recipientInput);
  const amount = parseNativeTransferAmount(amountInput);
  if (wallet === recipient) throw new NativeTransferError("SELF_TRANSFER");
  const { dependencies: api, storage, timeoutMs, requestTimeoutMs, pollIntervalMs, now, sleep } = settings(options);
  return withWalletWriteGuard(wallet, async () => {
    if (loadNativeTransfers(storage).some((record) => record.walletAddress === wallet)) throw new NativeTransferError("PENDING_TRANSFER");
    const startedAt = now();
    const preflight = <T>(work: () => Promise<T>) => bounded(work, Math.min(requestTimeoutMs, Math.max(1, 15_000 - (now() - startedAt))), options.signal);
    try { await preflight(() => api.identity(account)); }
    catch (error) { if (options.signal?.aborted) throw new NativeTransferError("ABORTED"); if (error instanceof NativeTransferError) throw error; throw new NativeTransferError("INVALID_IDENTITY"); }
    const chainId = await preflight(api.chainId);
    if (chainId !== THRU_NETWORK.expectedChainId) throw new NativeTransferError("WRONG_NETWORK");
    const source = await preflight(() => api.readAccount(wallet));
    const destination = await preflight(() => api.readAccount(recipient));
    assertNativeEoa(source, wallet);
    assertNativeEoa(destination, recipient);
    if (!source.meta || !destination.meta) throw new NativeTransferError("INVALID_ACCOUNT");
    validateNativeTransferBalances(source.meta.balance, destination.meta.balance, amount);
    const nonce = source.meta?.nonce;
    const startSlot = await preflight(api.finalizedSlot);
    if (typeof nonce !== "bigint" || nonce < 0n || nonce > NATIVE_U64_MAX || typeof startSlot !== "bigint" || startSlot <= 0n || startSlot > NATIVE_U64_MAX) throw new NativeTransferError("INVALID_CONTEXT");
    const intent = { walletAddress: wallet, recipientAddress: recipient, amountRaw: amount.toString(), nonce: nonce.toString(), startSlot: startSlot.toString() };
    const transaction = await preflight(() => buildTransactionForSigning({
      feePayer: { publicKey: account.publicKey }, program: EOA_PROGRAM_ID,
      accounts: { readWrite: [recipient] },
      header: { ...NATIVE_TRANSFER_HEADER, chainId, nonce, startSlot },
      instructionData: async ({ getAccountIndex }) => buildNativeTransferInstruction(amount, getAccountIndex(wallet), getAccountIndex(recipient)),
    }, options.signal, api.build));
    assertIntent(transaction, intent);
    // Recheck after build: never sign a stale nonce or an exhausted context.
    const freshSource = await preflight(() => api.readAccount(wallet));
    const freshDestination = await preflight(() => api.readAccount(recipient));
    const freshSlot = await preflight(api.finalizedSlot);
    const freshChain = await preflight(api.chainId);
    assertNativeEoa(freshSource, wallet);
    assertNativeEoa(freshDestination, recipient);
    if (!freshSource.meta || !freshDestination.meta) throw new NativeTransferError("INVALID_ACCOUNT");
    validateNativeTransferBalances(freshSource.meta.balance, freshDestination.meta.balance, amount);
    if (freshSource.meta?.nonce !== nonce || freshChain !== chainId || freshSlot < startSlot || freshSlot - startSlot >= 100n || now() - startedAt >= 15_000) throw new NativeTransferError("INVALID_CONTEXT");
    await preflight(() => signTransactionForSubmission(transaction, account.privateKey, options.signal));
    const signature = transaction.getSignature()?.toThruFmt();
    if (!signature) throw new NativeTransferError("INVALID_TRANSACTION");
    const record: PendingNativeTransfer = { version: 1, network: THRU_NETWORK.storageScope, ...intent,
      signature, bodyHash: await bodyHash(transaction), createdAt: Math.floor(options.now ? now() : Date.now()), status: "prepared" };
    const wire = transaction.toWire();
    // Serializing must not change the signed body. Public SDK verification, not custom crypto.
    const { Transaction } = await import("@thru/sdk");
    await verifyIntent(Transaction.fromWire(wire), record);
    if (options.signal?.aborted || now() - startedAt >= 15_000) throw new NativeTransferError("ABORTED");
    persistNativeTransfer(record, storage); // Verified durable write BEFORE the single send boundary.
    if (options.signal?.aborted) {
      removeNativeTransfer(record, storage); // Known not submitted; safe to cancel.
      throw new NativeTransferError("ABORTED");
    }
    let observed: TransactionStatusLike | undefined;
    try {
      const result = await submitSignedTransactionOnce({ rawTransaction: wire, expectedSignature: signature,
        timeoutMs, pollIntervalMs, now, pollingSignal: options.signal,
        sleep: (ms) => bounded(() => sleep(ms), ms + 100, options.signal),
        // Abort after the send boundary remains uncertain, never "not sent".
        send: (raw) => bounded(() => api.send(raw), requestTimeoutMs),
        getStatus: async (value) => {
          if (options.signal?.aborted) throw new NativeTransferError("ABORTED");
          const status = await bounded(() => api.status(value), requestTimeoutMs, options.signal);
          if (Signature.from(status.signature).toThruFmt() !== signature) throw new NativeTransferError("INVALID_TRANSACTION");
          if (!authoritative(status) || !validExecution(status)) {
            return { signature: status.signature, statusCode: ConsensusStatus.INCLUDED };
          }
          await bounded(async () => verifyIntent(await api.transaction(value), record), requestTimeoutMs, options.signal);
          observed = status;
          return status;
        },
      });
      if (result.failure) return complete(record, storage, "failure", observed);
      if (result.finalized && result.executionSucceeded) return complete(record, storage, "success", observed);
    } catch {
      // A journal/fence cleanup failure cannot undo a transaction already
      // verified by its exact body and authoritative execution result.
      if (observed) return complete(record, storage, failed(observed) ? "failure" : "success", observed);
      // Otherwise retain the original signature; no alternate send/balance fallback.
    }
    return complete(record, storage, "uncertain");
  }, { required: true, locks: options.locks, storage }).catch((error: unknown) => {
    if (error instanceof NativeTransferError || error instanceof WriteOperationBlockedError) throw error;
    throw new NativeTransferError(options.signal?.aborted ? "ABORTED" : "RPC_UNAVAILABLE");
  });
}

/** Reload-safe public-intent recovery. This function has no wallet key or send/build/sign path. */
export async function reconcileNativeTransfer(walletInput: string, options: NativeTransferOptions = {}): Promise<NativeTransferResult | null> {
  const wallet = nativeTransferAddress(walletInput);
  const { dependencies: api, storage, timeoutMs, requestTimeoutMs, pollIntervalMs, now, sleep } = settings(options);
  return withWalletWriteGuard(wallet, async () => {
    const record = loadNativeTransfers(storage).find((item) => item.walletAddress === wallet);
    if (!record) return null;
    const startedAt = now();
    while (!options.signal?.aborted && now() - startedAt < timeoutMs) {
      try {
        if (await bounded(api.chainId, requestTimeoutMs, options.signal) !== THRU_NETWORK.expectedChainId) break;
        const status = await bounded(() => api.status(record.signature), requestTimeoutMs, options.signal);
        if (Signature.from(status.signature).toThruFmt() !== record.signature) break;
        if (authoritative(status) && validExecution(status)) {
          await bounded(async () => verifyIntent(await api.transaction(record.signature), record), requestTimeoutMs, options.signal);
          return complete(record, storage, failed(status) ? "failure" : "success", status);
        }
      } catch (error) {
        if (error instanceof NativeTransferError && error.code === "INVALID_TRANSACTION") break;
        // not_found and transient read errors mean visibility delay, not failure.
      }
      if (options.signal?.aborted) break;
      const remaining = timeoutMs - (now() - startedAt);
      if (remaining <= 0) break;
      await bounded(() => sleep(Math.min(pollIntervalMs, remaining)), Math.min(pollIntervalMs, remaining) + 100, options.signal).catch(() => undefined);
    }
    return complete(record, storage, "uncertain");
  }, { required: true, readOnlyRecovery: true, locks: options.locks, storage });
}
