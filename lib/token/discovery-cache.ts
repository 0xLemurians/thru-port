import { networkStorageKey, THRU_NETWORK } from "../thru/network";
import { canonicalDiscoveryAddress, validContinuation, type DiscoveryContinuation, type VerifiedHolding, type HoldingAccount } from "./discovery";
import type { MintAccountInfo } from "@thru/programs/token";

export interface DiscoveryCache {
  version: 1; network: string; chainId: number; walletAddress: string;
  holdings: VerifiedHolding[]; continuation: DiscoveryContinuation | null; savedAt: number;
}
export type CacheLoadResult = { status: "ok"; value: DiscoveryCache } |
  { status: "absent" | "corrupt" | "unavailable"; value: null };
export const MAX_DISCOVERY_CACHE_BYTES = 512_000;
const MAX_MINTS = 128, MAX_ACCOUNTS = 512;
type CacheStorage = Pick<Storage, "getItem" | "setItem">;
export function discoveryCacheKey(wallet: string) {
  return networkStorageKey("thru.tokenDiscovery", 1) + "." + canonicalDiscoveryAddress(wallet);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid public cache");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error("Invalid public fields");
}
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid address");
  return canonicalDiscoveryAddress(value);
}
function raw(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new Error("Invalid integer");
  return value;
}
function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid time");
  return value;
}
function finality(value: unknown): "provisional" | "authoritative" {
  if (value !== "provisional" && value !== "authoritative") throw new Error("Invalid read state");
  return value;
}
function mint(value: unknown): MintAccountInfo {
  const row = object(value);
  exact(row, ["creator", "mintAuthority", "freezeAuthority", "hasFreezeAuthority", "decimals", "supply", "ticker"]);
  if (typeof row.decimals !== "number" || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255 ||
      typeof row.ticker !== "string" || new TextEncoder().encode(row.ticker).length > 8 || /[\u0000-\u001f\u007f\ufffd]/u.test(row.ticker) ||
      typeof row.hasFreezeAuthority !== "boolean" || (row.hasFreezeAuthority ? typeof row.freezeAuthority !== "string" : row.freezeAuthority !== null)) throw new Error("Invalid mint");
  return { creator: address(row.creator), mintAuthority: address(row.mintAuthority),
    freezeAuthority: row.freezeAuthority === null ? null : address(row.freezeAuthority),
    hasFreezeAuthority: row.hasFreezeAuthority, decimals: row.decimals, supply: BigInt(raw(row.supply)), ticker: row.ticker };
}
function holding(value: unknown, wallet: string): VerifiedHolding {
  const row = object(value);
  exact(row, ["mintAddress", "mint", "mintFinality", "mintSlot", "mintSeq", "verifiedAt", "accounts"]);
  const mintAddress = address(row.mintAddress);
  if (!Array.isArray(row.accounts) || !row.accounts.length || row.accounts.length > MAX_ACCOUNTS) throw new Error("Invalid accounts");
  const accounts: HoldingAccount[] = row.accounts.map((value) => {
    const account = object(value);
    exact(account, ["address", "state", "verifiedAt", "finality", "slot", "seq"]);
    const state = object(account.state);
    exact(state, ["owner", "mint", "amount", "isFrozen"]);
    if (state.owner !== wallet || state.mint !== mintAddress || typeof state.isFrozen !== "boolean") throw new Error("Invalid ownership");
    return { address: address(account.address), verifiedAt: time(account.verifiedAt), finality: finality(account.finality),
      slot: raw(account.slot), seq: raw(account.seq),
      state: { owner: wallet, mint: mintAddress, amount: BigInt(raw(state.amount)), isFrozen: state.isFrozen } };
  });
  if (new Set(accounts.map((account) => account.address)).size !== accounts.length) throw new Error("Duplicate account");
  return { mintAddress, mint: mint(row.mint), mintFinality: finality(row.mintFinality),
    mintSlot: raw(row.mintSlot), mintSeq: raw(row.mintSeq), verifiedAt: time(row.verifiedAt), accounts };
}
function parseCache(value: unknown, wallet: string): DiscoveryCache {
  const row = object(value);
  exact(row, ["version", "network", "chainId", "walletAddress", "holdings", "continuation", "savedAt"]);
  if (row.version !== 1 || row.network !== THRU_NETWORK.storageScope || row.chainId !== THRU_NETWORK.expectedChainId ||
      row.walletAddress !== wallet || !Array.isArray(row.holdings) || row.holdings.length > MAX_MINTS) throw new Error("Wrong cache scope");
  const holdings = row.holdings.map((value) => holding(value, wallet));
  const accounts = holdings.flatMap((group) => group.accounts);
  if (new Set(holdings.map((group) => group.mintAddress)).size !== holdings.length ||
      accounts.length > MAX_ACCOUNTS || new Set(accounts.map((account) => account.address)).size !== accounts.length) throw new Error("Duplicate/oversized cache");
  let continuation: DiscoveryContinuation | null = null;
  if (row.continuation !== null) {
    const next = object(row.continuation);
    exact(next, ["version", "network", "walletAddress", "program", "cursor", "seenCursors", "pendingAddresses", "inventoryExhausted"]);
    // Validate all untrusted fields before using a continuation.
    if (next.version !== 1 || typeof next.network !== "string" || typeof next.walletAddress !== "string" ||
        typeof next.program !== "string" || (next.cursor !== null && typeof next.cursor !== "string") ||
        !Array.isArray(next.seenCursors) || !next.seenCursors.every((item): item is string => typeof item === "string") ||
        !Array.isArray(next.pendingAddresses) || !next.pendingAddresses.every((item): item is string => typeof item === "string") ||
        typeof next.inventoryExhausted !== "boolean") throw new Error("Invalid continuation");
    continuation = validContinuation({ version: 1, network: next.network, walletAddress: next.walletAddress,
      program: next.program, cursor: next.cursor, seenCursors: next.seenCursors,
      pendingAddresses: next.pendingAddresses, inventoryExhausted: next.inventoryExhausted }, wallet);
  }
  return { version: 1, network: THRU_NETWORK.storageScope, chainId: THRU_NETWORK.expectedChainId,
    walletAddress: wallet, holdings, continuation, savedAt: time(row.savedAt) };
}
export function loadDiscoveryCache(storage: Pick<Storage, "getItem"> | null, wallet: string): CacheLoadResult {
  if (!storage) return { status: "unavailable", value: null };
  let encoded: string | null;
  try { encoded = storage.getItem(discoveryCacheKey(wallet)); } catch { return { status: "unavailable", value: null }; }
  if (encoded === null) return { status: "absent", value: null };
  try {
    if (encoded.length > MAX_DISCOVERY_CACHE_BYTES || new TextEncoder().encode(encoded).length > MAX_DISCOVERY_CACHE_BYTES) throw new Error();
    return { status: "ok", value: parseCache(JSON.parse(encoded), wallet) };
  } catch { return { status: "corrupt", value: null }; }
}
function newer(slot: string, seq: string, previousSlot: string, previousSeq: string) {
  return BigInt(slot) > BigInt(previousSlot) || (slot === previousSlot && BigInt(seq) >= BigInt(previousSeq));
}
/** Additive merge: a partial/empty response never deletes previously observed holdings. */
export function mergeDiscoveryHoldings(previous: VerifiedHolding[], incoming: VerifiedHolding[]): VerifiedHolding[] {
  const groups = new Map(previous.map((group) => [group.mintAddress, { ...group, accounts: [...group.accounts] }]));
  for (const group of incoming) {
    const old = groups.get(group.mintAddress);
    if (!old) { groups.set(group.mintAddress, { ...group, accounts: [...group.accounts] }); continue; }
    const accounts = new Map(old.accounts.map((account) => [account.address, account]));
    for (const account of group.accounts) {
      const before = accounts.get(account.address);
      if (!before || newer(account.slot, account.seq, before.slot, before.seq)) accounts.set(account.address, account);
    }
    const latest = newer(group.mintSlot, group.mintSeq, old.mintSlot, old.mintSeq) ? group : old;
    groups.set(group.mintAddress, { ...latest, accounts: [...accounts.values()] });
  }
  return [...groups.values()];
}
/** Whitelist serialization; no arbitrary object or secret field is persisted. */
export function saveDiscoveryCache(storage: CacheStorage | null, cache: DiscoveryCache): "ok" | "unavailable" | "limited" {
  if (!storage) return "unavailable";
  try {
    // Re-read immediately before a synchronous write: separate consumers can finish
    // partial scans in either order without dropping previously cached holdings.
    const previous = loadDiscoveryCache(storage, cache.walletAddress);
    if (previous.status === "unavailable") return "unavailable";
    const holdings = mergeDiscoveryHoldings(previous.value?.holdings ?? [], cache.holdings);
    if (holdings.length > MAX_MINTS || holdings.reduce((count, group) => count + group.accounts.length, 0) > MAX_ACCOUNTS) return "limited";
    const serialized = JSON.stringify({ version: 1, network: cache.network, chainId: cache.chainId, walletAddress: cache.walletAddress,
      savedAt: cache.savedAt, continuation: cache.continuation ? { version: 1, network: cache.continuation.network,
        walletAddress: cache.continuation.walletAddress, program: cache.continuation.program, cursor: cache.continuation.cursor,
        seenCursors: cache.continuation.seenCursors, pendingAddresses: cache.continuation.pendingAddresses,
        inventoryExhausted: cache.continuation.inventoryExhausted } : null,
      holdings: holdings.map((group) => ({
        mintAddress: group.mintAddress, mintFinality: group.mintFinality, mintSlot: group.mintSlot, mintSeq: group.mintSeq, verifiedAt: group.verifiedAt,
        mint: { creator: group.mint.creator, mintAuthority: group.mint.mintAuthority, freezeAuthority: group.mint.freezeAuthority,
          hasFreezeAuthority: group.mint.hasFreezeAuthority, decimals: group.mint.decimals, supply: group.mint.supply.toString(), ticker: group.mint.ticker },
        accounts: group.accounts.map((account) => ({ address: account.address, verifiedAt: account.verifiedAt, finality: account.finality,
          slot: account.slot, seq: account.seq, state: { owner: account.state.owner, mint: account.state.mint,
            amount: account.state.amount.toString(), isFrozen: account.state.isFrozen } })),
      })) });
    if (new TextEncoder().encode(serialized).length > MAX_DISCOVERY_CACHE_BYTES) return "limited";
    parseCache(JSON.parse(serialized), cache.walletAddress);
    const key = discoveryCacheKey(cache.walletAddress);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) return "unavailable";
    return "ok";
  } catch { return "unavailable"; }
}
export function publicDiscoveryStorage(): CacheStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
