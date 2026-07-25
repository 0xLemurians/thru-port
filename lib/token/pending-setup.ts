/**
 * Pending token setup storage.
 *
 * Persists public (non-secret) information about a token creation that was
 * submitted to the chain but whose final on-chain verification has not yet
 * completed. This allows the UI to offer a "Recover created token" flow after
 * a page refresh or wallet re-import.
 *
 * SECURITY: Only public on-chain addresses, labels, and amounts are stored.
 * Private keys, mnemonics, and backup contents are never written here.
 */

import { Pubkey } from "@thru/sdk";

export const PENDING_SETUP_STORAGE_KEY =
  "thru.tokenStudio.alphanet.pendingSetups.v1";

const MAX_PENDING_SETUPS = 16;
const PENDING_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PendingTokenSetup {
  /** The wallet that created the token (public address only). */
  walletAddress: string;
  /** Derived mint address (public). */
  mintAddress: string;
  /** Derived token account address (public). */
  tokenAccountAddress: string;
  /** User-supplied display label (e.g. "MVP Test"). */
  name: string;
  /** User-supplied ticker (e.g. "MVP"). */
  ticker: string;
  /** Decimal count (e.g. 2). */
  decimals: number;
  /** Display-unit initial supply string (e.g. "10"). */
  initialSupply: string;
  /** Mint transaction signature, if obtained. */
  mintSignature?: string;
  /** Token-account transaction signature, if obtained. */
  tokenAccountSignature?: string;
  /** Initial-supply transaction signature, if obtained. */
  initialSupplySignature?: string;
  /** Unix timestamp (ms) when the setup was saved. */
  savedAt: number;
}

/** Load all pending setups from storage. Returns an empty array on error. */
export function loadPendingSetups(
  storage: Pick<Storage, "getItem">,
): PendingTokenSetup[] {
  const raw = storage.getItem(PENDING_SETUP_STORAGE_KEY);
  if (!raw) return [];
  try {
    return normalizePendingSetups(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Persist pending setups. Automatically prunes expired and excess entries. */
export function savePendingSetups(
  storage: Pick<Storage, "setItem">,
  setups: PendingTokenSetup[],
): void {
  storage.setItem(
    PENDING_SETUP_STORAGE_KEY,
    JSON.stringify(normalizePendingSetups(setups)),
  );
}

/**
 * Upsert a pending setup by mint address.
 * If a setup for the same mint already exists it is replaced in-place.
 */
export function upsertPendingSetup(
  setups: PendingTokenSetup[],
  input: PendingTokenSetup,
): PendingTokenSetup[] {
  const normalized = normalizePendingSetups(setups);
  const idx = normalized.findIndex(
    (s) => s.mintAddress === input.mintAddress,
  );
  if (idx === -1) {
    if (normalized.length >= MAX_PENDING_SETUPS) {
      // Evict the oldest entry.
      normalized.sort((a, b) => a.savedAt - b.savedAt);
      normalized.shift();
    }
    return [...normalized, input];
  }
  const next = [...normalized];
  next[idx] = input;
  return next;
}

/** Remove a pending setup by mint address. */
export function removePendingSetup(
  setups: PendingTokenSetup[],
  mintAddress: string,
): PendingTokenSetup[] {
  return setups.filter((s) => s.mintAddress !== mintAddress);
}

/** Return pending setups that belong to the given wallet address. */
export function pendingSetupsForWallet(
  setups: PendingTokenSetup[],
  walletAddress: string,
): PendingTokenSetup[] {
  return setups.filter((s) => s.walletAddress === walletAddress);
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizePendingSetups(value: unknown): PendingTokenSetup[] {
  if (!Array.isArray(value)) return [];
  const now = Date.now();
  const valid: PendingTokenSetup[] = [];

  for (const candidate of value.slice(0, MAX_PENDING_SETUPS * 2)) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;

    // Validate required string fields.
    const walletAddress = safeAddress(raw.walletAddress);
    const mintAddress = safeAddress(raw.mintAddress);
    const tokenAccountAddress = safeAddress(raw.tokenAccountAddress);
    if (!walletAddress || !mintAddress || !tokenAccountAddress) continue;

    const name = safeString(raw.name, 64) ?? "";
    const ticker = safeString(raw.ticker, 16) ?? "";
    const decimals =
      typeof raw.decimals === "number" &&
      Number.isInteger(raw.decimals) &&
      raw.decimals >= 0 &&
      raw.decimals <= 18
        ? raw.decimals
        : null;
    const initialSupply = safeString(raw.initialSupply, 64) ?? "0";
    const savedAt =
      typeof raw.savedAt === "number" && raw.savedAt > 0 ? raw.savedAt : 0;

    if (decimals === null) continue;
    if (savedAt === 0) continue;
    // Drop entries older than TTL.
    if (now - savedAt > PENDING_SETUP_TTL_MS) continue;

    valid.push({
      walletAddress,
      mintAddress,
      tokenAccountAddress,
      name,
      ticker,
      decimals,
      initialSupply,
      ...(safeString(raw.mintSignature, 128)
        ? { mintSignature: safeString(raw.mintSignature, 128)! }
        : {}),
      ...(safeString(raw.tokenAccountSignature, 128)
        ? { tokenAccountSignature: safeString(raw.tokenAccountSignature, 128)! }
        : {}),
      ...(safeString(raw.initialSupplySignature, 128)
        ? {
            initialSupplySignature: safeString(
              raw.initialSupplySignature,
              128,
            )!,
          }
        : {}),
      savedAt,
    });
  }

  // Deduplicate by mintAddress (latest wins).
  const seen = new Map<string, PendingTokenSetup>();
  for (const s of valid) {
    const existing = seen.get(s.mintAddress);
    if (!existing || s.savedAt > existing.savedAt) seen.set(s.mintAddress, s);
  }
  return Array.from(seen.values());
}

function safeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return Pubkey.from(trimmed).toThruFmt();
  } catch {
    return null;
  }
}

function safeString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}
