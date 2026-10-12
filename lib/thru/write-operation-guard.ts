import { ConsensusStatus, Signature, Transaction } from "@thru/sdk";
import { thru } from "./client";
import { networkStorageKey, THRU_NETWORK } from "./network";
import { loadNativeTransfers, nativeJournalStorage, type NativeJournalStorage } from "../wallet/pending-native-transfer";
import { PENDING_TOKEN_OPERATION_STORAGE_KEY } from "../token/pending-operation";

export class WriteOperationBlockedError extends Error {
  constructor() {
    super("Another write is active or still awaiting verification. Verify it before trying again.");
    this.name = "WriteOperationBlockedError";
  }
}

export interface WriteLockProvider {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: object | null) => Promise<T>): Promise<T>;
}
export interface WriteGuardOptions {
  locks?: WriteLockProvider;
  storage?: NativeJournalStorage;
  /** Native writes require Web Locks. Older writers retain compatibility only when native writes are unavailable. */
  required?: boolean;
  readOnlyRecovery?: boolean;
}
export interface WriteLease { readonly walletAddress: string }
const leases = new Map<string, { lease: WriteLease; storage: NativeJournalStorage }>();
const validLeases = new WeakSet<WriteLease>();
const fenceKey = (wallet: string) => `${networkStorageKey("thru.writeFence", 1)}.${wallet}`;

function saveFence(wallet: string, signature: string, storage: NativeJournalStorage): void {
  const value = JSON.stringify({ network: THRU_NETWORK.storageScope, wallet, signature });
  try {
    storage.setItem(fenceKey(wallet), value);
    if (storage.getItem(fenceKey(wallet)) !== value) throw new Error();
  } catch { throw new WriteOperationBlockedError(); }
}

export function clearWriteFence(wallet: string, storage: NativeJournalStorage): void {
  try {
    storage.setItem(fenceKey(wallet), "null");
    if (storage.getItem(fenceKey(wallet)) !== "null") throw new Error();
  } catch { throw new WriteOperationBlockedError(); }
}

export function resolveGuardedWrite(wallet: string): void {
  const active = leases.get(wallet);
  if (active) {
    try { clearWriteFence(wallet, active.storage); }
    catch { /* Verified chain success stays success; retained fence blocks later writes. */ }
  }
}

async function checkFence(wallet: string, storage: NativeJournalStorage): Promise<void> {
  const raw = storage.getItem(fenceKey(wallet));
  if (raw === null || raw === "null") return;
  try {
    const record = JSON.parse(raw);
    if (Object.keys(record).length !== 3 || record.network !== THRU_NETWORK.storageScope || record.wallet !== wallet ||
        Signature.from(record.signature).toThruFmt() !== record.signature) throw new Error();
    // Recovery is read-only, deadline-bounded and never uses balance movements.
    const status = await boundedGuardStatus(record.signature);
    if (Signature.from(status.signature).toThruFmt() !== record.signature ||
        ![ConsensusStatus.CLUSTER_EXECUTED, ConsensusStatus.FINALIZED].includes(status.statusCode ?? ConsensusStatus.UNSPECIFIED) ||
        !status.executionResult || !Number.isSafeInteger(status.executionResult.vmError) || status.executionResult.vmError < 0 ||
        typeof status.executionResult.userErrorCode !== "bigint" || status.executionResult.userErrorCode < 0n ||
        (status.executionResult.executionResult !== undefined && typeof status.executionResult.executionResult !== "bigint")) throw new Error();
    clearWriteFence(wallet, storage);
  } catch { throw new WriteOperationBlockedError(); }
}

async function boundedGuardStatus(signature: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      thru.transactions.getStatus(signature),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WriteOperationBlockedError()), 5_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Same-origin Web Locks cover preflight through reconciliation. Network-wide
 * serialization (stronger than wallet-only) also protects the shared journal's
 * synchronous read/modify/write across different wallets. ifAvailable rejects
 * a second action; it never queues a stale user intent for automatic submission.
 * Other origins, older app versions and external wallets cannot be coordinated.
 */
export async function withWalletWriteGuard<T>(wallet: string, work: (lease?: WriteLease) => Promise<T>, options: WriteGuardOptions = {}, nestedLease?: WriteLease): Promise<T> {
  if (nestedLease) {
    if (!validLeases.has(nestedLease) || nestedLease.walletAddress !== wallet) throw new WriteOperationBlockedError();
    return work(nestedLease);
  }
  const locks: WriteLockProvider | undefined = options.locks ??
    (typeof window !== "undefined" && typeof document !== "undefined" && typeof navigator !== "undefined" && navigator.locks ? {
      request: async (name, requestOptions, callback) =>
        await navigator.locks.request(name, requestOptions, callback),
    } : undefined);
  if (!locks) {
    if (options.required) throw new WriteOperationBlockedError();
    // Native core cannot run on this platform. Keep the existing writers' old
    // behavior, rather than falsely claiming cross-tab protection there.
    return work();
  }
  const storage = options.storage ?? nativeJournalStorage();
  return locks.request(`thru.write:${THRU_NETWORK.storageScope}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new WriteOperationBlockedError();
    if (!options.readOnlyRecovery) {
      if (loadNativeTransfers(storage).some((record) => record.walletAddress === wallet)) throw new WriteOperationBlockedError();
      if (options.required) {
        // Read without the token loader's historical age pruning. Old unresolved
        // public signatures must still fence a new native nonce allocation.
        try {
          const raw = storage.getItem(PENDING_TOKEN_OPERATION_STORAGE_KEY);
          const records: unknown = raw === null ? [] : JSON.parse(raw);
          if (!Array.isArray(records) || records.some((record) => !record || typeof record.walletAddress !== "string" || record.walletAddress === wallet)) throw new Error();
        } catch { throw new WriteOperationBlockedError(); }
      }
      await checkFence(wallet, storage);
    }
    const lease: WriteLease = Object.freeze({ walletAddress: wallet });
    validLeases.add(lease);
    leases.set(wallet, { lease, storage });
    try { return await work(lease); }
    finally { validLeases.delete(lease); leases.delete(wallet); }
  });
}

/** Called at the common unary send boundary, before any network submission. */
export function reserveGuardedSubmission(raw: Uint8Array, signature: string): (() => void) | undefined {
  if (leases.size === 0) return undefined;
  const transaction = Transaction.fromWire(raw);
  const wallet = transaction.feePayer.toThruFmt();
  const active = leases.get(wallet);
  if (!active || transaction.getSignature()?.toThruFmt() !== signature) throw new WriteOperationBlockedError();
  const current = active.storage.getItem(fenceKey(wallet));
  if (current !== null && current !== "null") throw new WriteOperationBlockedError();
  saveFence(wallet, signature, active.storage);
  return () => {
    try { clearWriteFence(wallet, active.storage); }
    catch { /* Keep the unresolved public fence; never turn proven execution into a retryable error. */ }
  };
}
