import { Signature } from "@thru/sdk";
import { networkStorageKey, THRU_NETWORK } from "../thru/network";
import { nativeTransferAddress, NativeTransferError, NATIVE_U64_MAX, parseNativeTransferAmount } from "./native-transfer-validation";

export const PENDING_NATIVE_TRANSFER_KEY = networkStorageKey("thru.nativeTransfers", 1);
export type NativeJournalStorage = Pick<Storage, "getItem" | "setItem">;
export interface PendingNativeTransfer {
  version: 1;
  network: string;
  walletAddress: string;
  recipientAddress: string;
  amountRaw: string;
  nonce: string;
  startSlot: string;
  signature: string;
  bodyHash: string;
  createdAt: number;
  status: "prepared" | "submitted" | "uncertain";
}

export function nativeJournalStorage(): NativeJournalStorage {
  try {
    if (typeof window === "undefined") throw new Error();
    return window.localStorage;
  } catch { throw new NativeTransferError("JOURNAL_UNAVAILABLE"); }
}

function validateRecord(value: unknown): PendingNativeTransfer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  const keys = ["version", "network", "walletAddress", "recipientAddress", "amountRaw", "nonce", "startSlot", "signature", "bodyHash", "createdAt", "status"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) throw new Error();
  if (record.version !== 1 || record.network !== THRU_NETWORK.storageScope ||
      typeof record.walletAddress !== "string" || typeof record.recipientAddress !== "string" ||
      typeof record.signature !== "string" || typeof record.amountRaw !== "string" ||
      typeof record.nonce !== "string" || typeof record.startSlot !== "string" ||
      typeof record.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(record.bodyHash) ||
      typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      (record.status !== "prepared" && record.status !== "submitted" && record.status !== "uncertain")) throw new Error();
  nativeTransferAddress(record.walletAddress);
  nativeTransferAddress(record.recipientAddress);
  if (record.walletAddress === record.recipientAddress || Signature.from(record.signature).toThruFmt() !== record.signature) throw new Error();
  parseNativeTransferAmount(record.amountRaw);
  for (const integer of [record.nonce, record.startSlot]) {
    if (!/^[0-9]{1,20}$/.test(integer) || BigInt(integer) > NATIVE_U64_MAX) throw new Error();
  }
  if (BigInt(record.startSlot) === 0n) throw new Error();
  return {
    version: 1, network: record.network, walletAddress: record.walletAddress,
    recipientAddress: record.recipientAddress, amountRaw: record.amountRaw,
    nonce: record.nonce, startSlot: record.startSlot, signature: record.signature,
    bodyHash: record.bodyHash, createdAt: record.createdAt, status: record.status,
  };
}

/** No age pruning, eviction, secret fields, legacy-network import or silent corruption recovery. */
export function loadNativeTransfers(storage: NativeJournalStorage): PendingNativeTransfer[] {
  try {
    const raw = storage.getItem(PENDING_NATIVE_TRANSFER_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    const records = parsed.map(validateRecord);
    if (new Set(records.map((record) => record.walletAddress)).size !== records.length) throw new Error();
    return records;
  } catch { throw new NativeTransferError("JOURNAL_UNAVAILABLE"); }
}

function save(records: PendingNativeTransfer[], storage: NativeJournalStorage): void {
  try {
    records.forEach(validateRecord);
    const serialized = JSON.stringify(records);
    storage.setItem(PENDING_NATIVE_TRANSFER_KEY, serialized);
    if (storage.getItem(PENDING_NATIVE_TRANSFER_KEY) !== serialized) throw new Error();
  } catch { throw new NativeTransferError("JOURNAL_UNAVAILABLE"); }
}

/** Caller must hold the wallet/network Web Lock for the entire read-modify-write. */
export function persistNativeTransfer(record: PendingNativeTransfer, storage: NativeJournalStorage): void {
  const records = loadNativeTransfers(storage);
  const existing = records.find((item) => item.walletAddress === record.walletAddress);
  if (existing && existing.signature !== record.signature) throw new NativeTransferError("PENDING_TRANSFER");
  save([...records.filter((item) => item.walletAddress !== record.walletAddress), record], storage);
}

/** Only call after transaction-specific authoritative verification (or known pre-send abort). */
export function removeNativeTransfer(record: PendingNativeTransfer, storage: NativeJournalStorage): void {
  save(loadNativeTransfers(storage).filter((item) => item.signature !== record.signature), storage);
}
