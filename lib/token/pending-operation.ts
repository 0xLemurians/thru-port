import { Pubkey, Signature } from "@thru/sdk";

export const PENDING_TOKEN_OPERATION_STORAGE_KEY =
  "thru.tokenStudio.alphanet.pendingOperations.v1";
export const PENDING_TOKEN_OPERATION_SCHEMA_VERSION = 1 as const;

const MAX_PENDING_OPERATIONS = 32;
const PENDING_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXPECTED_STATE_FIELDS = 24;
const serverJournal = new Map<string, string>();
const serverStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => serverJournal.get(key) ?? null,
  setItem: (key, value) => {
    serverJournal.set(key, value);
  },
};

export type PendingTokenOperationType =
  | "create-mint"
  | "create-token-account"
  | "initial-supply"
  | "destination-account"
  | "mint-additional"
  | "transfer";

export interface PendingTokenExpectedState {
  mintSupply?: string;
  mintDecimals?: number;
  mintCreator?: string;
  mintAuthority?: string;
  mintTicker?: string;
  sourceBalance?: string;
  sourceOwner?: string;
  destinationBalance?: string;
  destinationOwner?: string;
  destinationFrozen?: boolean;
}

export interface PendingTokenOperationRecord {
  schemaVersion: typeof PENDING_TOKEN_OPERATION_SCHEMA_VERSION;
  key: string;
  operationType: PendingTokenOperationType;
  signature: string;
  walletAddress: string;
  mintAddress: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
  recipientAddress?: string;
  amountRaw?: string;
  expectedPreState?: PendingTokenExpectedState;
  expectedPostState: PendingTokenExpectedState;
  createdAt: number;
  lastCheckedAt: number;
  status: "submitted" | "uncertain";
}

export interface CanonicalTokenOperationKeyInput {
  operationType: PendingTokenOperationType;
  walletAddress: string;
  mintAddress: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
  recipientAddress?: string;
  amountRaw?: bigint;
  derivedIdentifier?: string;
}

export type PendingOperationReconciliationOutcome =
  | { outcome: "none" }
  | { outcome: "success"; record: PendingTokenOperationRecord }
  | { outcome: "failure"; record: PendingTokenOperationRecord }
  | { outcome: "uncertain"; record: PendingTokenOperationRecord };

export class PendingOperationJournalError extends Error {
  constructor() {
    super(
      "The public pending-operation journal is unavailable. No new transaction was submitted.",
    );
    this.name = "PendingOperationJournalError";
  }
}

/**
 * Creates an unambiguous key from canonical public identifiers and the parsed
 * raw integer amount. Length-prefixing prevents delimiter collisions and does
 * not depend on object property order or the user's display formatting.
 */
export function canonicalTokenOperationKey(
  input: CanonicalTokenOperationKeyInput,
): string {
  const fields = [
    input.operationType,
    canonicalAddress(input.walletAddress),
    canonicalAddress(input.mintAddress),
    optionalAddress(input.sourceTokenAccount),
    optionalAddress(input.destinationTokenAccount),
    optionalAddress(input.recipientAddress),
    input.amountRaw?.toString(10) ?? "",
    boundedString(input.derivedIdentifier, 256) ?? "",
  ];
  return fields.map((value) => `${value.length}:${value}`).join("|");
}

export function loadPendingTokenOperations(
  storage: Pick<Storage, "getItem">,
  now = Date.now(),
): PendingTokenOperationRecord[] {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_TOKEN_OPERATION_STORAGE_KEY);
  } catch {
    throw new PendingOperationJournalError();
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PendingOperationJournalError();
  }
  if (!Array.isArray(parsed)) throw new PendingOperationJournalError();

  const normalized: PendingTokenOperationRecord[] = [];
  let invalidEntryFound = false;
  for (const candidate of parsed.slice(0, MAX_PENDING_OPERATIONS * 2)) {
    if (candidate && typeof candidate === "object") {
      const createdAt = safeTimestamp(
        (candidate as Record<string, unknown>).createdAt,
      );
      if (createdAt && now - createdAt > PENDING_OPERATION_TTL_MS) continue;
    }
    const record = normalizeRecord(candidate, now);
    if (record) normalized.push(record);
    else invalidEntryFound = true;
  }
  // A corrupt live entry is ambiguous: failing closed is safer than silently
  // forgetting a transaction and allowing it to be submitted again.
  if (invalidEntryFound) throw new PendingOperationJournalError();

  const byKey = new Map<string, PendingTokenOperationRecord>();
  for (const record of normalized) {
    const previous = byKey.get(record.key);
    if (!previous || previous.createdAt < record.createdAt) {
      byKey.set(record.key, record);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PENDING_OPERATIONS);
}

export function savePendingTokenOperations(
  storage: Pick<Storage, "setItem">,
  records: PendingTokenOperationRecord[],
  now = Date.now(),
): void {
  const normalized: PendingTokenOperationRecord[] = [];
  for (const record of records) {
    if (now - record.createdAt > PENDING_OPERATION_TTL_MS) continue;
    const safe = normalizeRecord(record, now);
    if (!safe) throw new PendingOperationJournalError();
    normalized.push(safe);
  }
  normalized.sort((a, b) => b.createdAt - a.createdAt);
  normalized.splice(MAX_PENDING_OPERATIONS);
  try {
    storage.setItem(
      PENDING_TOKEN_OPERATION_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    throw new PendingOperationJournalError();
  }
}

export function upsertPendingTokenOperation(
  records: PendingTokenOperationRecord[],
  input: PendingTokenOperationRecord,
): PendingTokenOperationRecord[] {
  const remaining = records.filter((record) => record.key !== input.key);
  return [input, ...remaining].slice(0, MAX_PENDING_OPERATIONS);
}

export function removePendingTokenOperation(
  records: PendingTokenOperationRecord[],
  key: string,
): PendingTokenOperationRecord[] {
  return records.filter((record) => record.key !== key);
}

export function findPendingTokenOperation(
  records: PendingTokenOperationRecord[],
  key: string,
  walletAddress: string,
): PendingTokenOperationRecord | undefined {
  const canonicalWallet = canonicalAddress(walletAddress);
  return records.find(
    (record) => record.key === key && record.walletAddress === canonicalWallet,
  );
}

/** Resolve browser localStorage without silently falling back in a browser. */
export function pendingTokenOperationStorage(): Pick<
  Storage,
  "getItem" | "setItem"
> {
  if (typeof window === "undefined") return serverStorage;
  try {
    return window.localStorage;
  } catch {
    throw new PendingOperationJournalError();
  }
}

export function readPendingTokenOperation(
  key: string,
  walletAddress: string,
): PendingTokenOperationRecord | undefined {
  const records = loadPendingTokenOperations(pendingTokenOperationStorage());
  return findPendingTokenOperation(records, key, walletAddress);
}

export function persistPendingTokenOperation(
  record: PendingTokenOperationRecord,
): void {
  const storage = pendingTokenOperationStorage();
  const records = loadPendingTokenOperations(storage);
  savePendingTokenOperations(storage, upsertPendingTokenOperation(records, record));
}

export function clearPendingTokenOperation(
  key: string,
  walletAddress: string,
): void {
  const storage = pendingTokenOperationStorage();
  const records = loadPendingTokenOperations(storage);
  const matching = findPendingTokenOperation(records, key, walletAddress);
  if (!matching) return;
  savePendingTokenOperations(storage, removePendingTokenOperation(records, key));
}

/**
 * Reconcile one journal entry through caller-provided read-only evidence.
 * This helper has no transaction builder, signer, serializer, or transport
 * submission dependency, so it cannot rebroadcast the recorded transaction.
 */
export async function reconcilePendingTokenOperationJournal(input: {
  key: string;
  walletAddress: string;
  verify: (
    record: PendingTokenOperationRecord,
  ) => Promise<"success" | "failure" | "uncertain">;
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
  retainOnSuccess?: boolean;
}): Promise<PendingOperationReconciliationOutcome> {
  const storage = input.storage ?? pendingTokenOperationStorage();
  const now = input.now ?? Date.now;
  const records = loadPendingTokenOperations(storage, now());
  const record = findPendingTokenOperation(
    records,
    input.key,
    input.walletAddress,
  );
  if (!record) return { outcome: "none" };

  let outcome: "success" | "failure" | "uncertain";
  try {
    outcome = await input.verify(record);
  } catch {
    outcome = "uncertain";
  }
  if (outcome === "success" && input.retainOnSuccess) {
    return { outcome, record };
  }
  if (outcome === "success" || outcome === "failure") {
    savePendingTokenOperations(
      storage,
      removePendingTokenOperation(records, record.key),
      now(),
    );
    return { outcome, record };
  }

  const uncertain: PendingTokenOperationRecord = {
    ...record,
    lastCheckedAt: now(),
    status: "uncertain",
  };
  savePendingTokenOperations(
    storage,
    upsertPendingTokenOperation(records, uncertain),
    now(),
  );
  return { outcome: "uncertain", record: uncertain };
}

function normalizeRecord(
  candidate: unknown,
  now: number,
): PendingTokenOperationRecord | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as Record<string, unknown>;
  if (raw.schemaVersion !== PENDING_TOKEN_OPERATION_SCHEMA_VERSION) return null;
  if (!isOperationType(raw.operationType)) return null;
  const key = boundedString(raw.key, 2048);
  const signature = canonicalSignature(raw.signature);
  const walletAddress = safeAddress(raw.walletAddress);
  const mintAddress = safeAddress(raw.mintAddress);
  if (!key || !signature || !walletAddress || !mintAddress) return null;
  const createdAt = safeTimestamp(raw.createdAt);
  const lastCheckedAt = safeTimestamp(raw.lastCheckedAt);
  if (!createdAt || !lastCheckedAt || createdAt > now + 60_000) return null;
  // Expired records are intentionally pruned rather than treated as corrupt.
  if (now - createdAt > PENDING_OPERATION_TTL_MS) return null;
  if (raw.status !== "submitted" && raw.status !== "uncertain") return null;
  const expectedPostState = normalizeExpectedState(raw.expectedPostState);
  if (!expectedPostState) return null;
  const expectedPreState =
    raw.expectedPreState === undefined
      ? undefined
      : normalizeExpectedState(raw.expectedPreState);
  if (raw.expectedPreState !== undefined && !expectedPreState) return null;
  const amountRaw = optionalRawAmount(raw.amountRaw);
  if (raw.amountRaw !== undefined && amountRaw === undefined) return null;

  return {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key,
    operationType: raw.operationType,
    signature,
    walletAddress,
    mintAddress,
    ...(optionalSafeAddress(raw.sourceTokenAccount)
      ? { sourceTokenAccount: optionalSafeAddress(raw.sourceTokenAccount)! }
      : {}),
    ...(optionalSafeAddress(raw.destinationTokenAccount)
      ? {
          destinationTokenAccount: optionalSafeAddress(
            raw.destinationTokenAccount,
          )!,
        }
      : {}),
    ...(optionalSafeAddress(raw.recipientAddress)
      ? { recipientAddress: optionalSafeAddress(raw.recipientAddress)! }
      : {}),
    ...(amountRaw !== undefined ? { amountRaw } : {}),
    ...(expectedPreState ? { expectedPreState } : {}),
    expectedPostState,
    createdAt,
    lastCheckedAt,
    status: raw.status,
  };
}

function normalizeExpectedState(value: unknown): PendingTokenExpectedState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length > MAX_EXPECTED_STATE_FIELDS) return null;
  const state: PendingTokenExpectedState = {};
  for (const field of [
    "mintSupply",
    "sourceBalance",
    "destinationBalance",
  ] as const) {
    const amount = optionalRawAmount(raw[field]);
    if (raw[field] !== undefined && amount === undefined) return null;
    if (amount !== undefined) state[field] = amount;
  }
  if (raw.mintDecimals !== undefined) {
    if (
      typeof raw.mintDecimals !== "number" ||
      !Number.isInteger(raw.mintDecimals) ||
      raw.mintDecimals < 0 ||
      raw.mintDecimals > 18
    ) {
      return null;
    }
    state.mintDecimals = raw.mintDecimals;
  }
  for (const field of [
    "mintCreator",
    "mintAuthority",
    "sourceOwner",
    "destinationOwner",
  ] as const) {
    const address = optionalSafeAddress(raw[field]);
    if (raw[field] !== undefined && !address) return null;
    if (address) state[field] = address;
  }
  if (raw.mintTicker !== undefined) {
    const ticker = boundedString(raw.mintTicker, 32);
    if (!ticker) return null;
    state.mintTicker = ticker;
  }
  if (raw.destinationFrozen !== undefined) {
    if (typeof raw.destinationFrozen !== "boolean") return null;
    state.destinationFrozen = raw.destinationFrozen;
  }
  return state;
}

function canonicalAddress(value: string): string {
  return Pubkey.from(value).toThruFmt();
}

function safeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return canonicalAddress(value);
  } catch {
    return null;
  }
}

function optionalSafeAddress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return safeAddress(value) ?? undefined;
}

function optionalAddress(value: string | undefined): string {
  return value ? canonicalAddress(value) : "";
}

function canonicalSignature(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return Signature.from(value).toThruFmt();
  } catch {
    return null;
  }
}

function optionalRawAmount(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value).toString(10);
  } catch {
    return undefined;
  }
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

function isOperationType(value: unknown): value is PendingTokenOperationType {
  return (
    value === "create-mint" ||
    value === "create-token-account" ||
    value === "initial-supply" ||
    value === "destination-account" ||
    value === "mint-additional" ||
    value === "transfer"
  );
}
