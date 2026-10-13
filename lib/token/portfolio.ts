import { Pubkey } from "@thru/sdk";
import { formatRawAmount } from "@thru/programs/token";
import type { TokenPortfolioItem } from "./thru-token";
import type { VerifiedHolding } from "./discovery";
import { networkStorageKey } from "@/lib/thru/network";
import {
  validateTokenDecimals,
  validateTokenName,
  validateTokenTicker,
} from "./validation";

export const TOKEN_PORTFOLIO_STORAGE_KEY =
  networkStorageKey("thru.tokenStudio.knownTokens", 1);
export const LEGACY_ALPHANET_TOKEN_PORTFOLIO_STORAGE_KEY =
  "thru.tokenStudio.alphanet.knownTokens.v1";

export const MAX_KNOWN_MINTS = 64;
const MAX_KNOWN_RECORDS = 256;
const MAX_ACCOUNTS_PER_MINT = 128;
export const MAX_BACKUP_CREATED_TOKENS = 32;
export const MAX_BACKUP_ACCOUNTS_PER_MINT = 4;

export interface KnownTokenRecord {
  mintAddress: string;
  label?: string;
  walletAddress?: string;
  creatorAddress?: string;
  mintAuthorityAddress?: string;
  ticker?: string;
  decimals?: number;
  tokenAccountAddresses: string[];
}

export function loadKnownTokens(
  storage: Pick<Storage, "getItem">,
): KnownTokenRecord[] {
  try {
    const raw = storage.getItem(TOKEN_PORTFOLIO_STORAGE_KEY);
    if (!raw) return [];
    return normalizeKnownTokens(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveKnownTokens(
  storage: Pick<Storage, "setItem">,
  records: KnownTokenRecord[],
): void {
  storage.setItem(
    TOKEN_PORTFOLIO_STORAGE_KEY,
    JSON.stringify(normalizeKnownTokens(records)),
  );
}

export function upsertKnownToken(
  records: KnownTokenRecord[],
  input: {
    mintAddress: string;
    tokenAccountAddress?: string;
    label?: string;
    walletAddress?: string;
    creatorAddress?: string;
    mintAuthorityAddress?: string;
    ticker?: string;
    decimals?: number;
  },
): KnownTokenRecord[] {
  const mintAddress = normalizeAddress(input.mintAddress, "Mint address");
  const tokenAccountAddress = input.tokenAccountAddress?.trim()
    ? normalizeAddress(input.tokenAccountAddress, "Token account address")
    : undefined;
  const label = normalizeLabel(input.label);
  const normalized = normalizeKnownTokens(records);
  const walletAddress = input.walletAddress?.trim()
    ? normalizeAddress(input.walletAddress, "Wallet address")
    : undefined;
  const existingIndex = normalized.findIndex(
    (record) =>
      record.mintAddress === mintAddress &&
      record.walletAddress === walletAddress,
  );
  const creatorAddress = normalizeOptionalAddress(
    input.creatorAddress,
    "Creator address",
  );
  const mintAuthorityAddress = normalizeOptionalAddress(
    input.mintAuthorityAddress,
    "Mint authority address",
  );
  const ticker = normalizeTicker(input.ticker);
  const decimals = normalizeDecimals(input.decimals);

  if (existingIndex === -1) {
    const walletRecordCount = normalized.filter(
      (record) => record.walletAddress === walletAddress,
    ).length;
    if (
      normalized.length >= MAX_KNOWN_RECORDS ||
      walletRecordCount >= MAX_KNOWN_MINTS
    ) {
      throw new Error(`At most ${MAX_KNOWN_MINTS} known mints can be stored.`);
    }
    return [
      ...normalized,
      {
        mintAddress,
        ...(label ? { label } : {}),
        ...(walletAddress ? { walletAddress } : {}),
        ...(creatorAddress ? { creatorAddress } : {}),
        ...(mintAuthorityAddress ? { mintAuthorityAddress } : {}),
        ...(ticker ? { ticker } : {}),
        ...(decimals !== undefined ? { decimals } : {}),
        tokenAccountAddresses: tokenAccountAddress
          ? [tokenAccountAddress]
          : [],
      },
    ];
  }

  const next = [...normalized];
  const existing = next[existingIndex];
  const accountAddresses = tokenAccountAddress
    ? Array.from(
        new Set([...existing.tokenAccountAddresses, tokenAccountAddress]),
      )
    : existing.tokenAccountAddresses;
  if (accountAddresses.length > MAX_ACCOUNTS_PER_MINT) {
    throw new Error(
      `At most ${MAX_ACCOUNTS_PER_MINT} token accounts can be stored per mint.`,
    );
  }
  next[existingIndex] = {
    ...existing,
    ...(label ? { label: existing.label ?? label } : {}),
    ...(walletAddress ? { walletAddress } : {}),
    ...(creatorAddress ? { creatorAddress } : {}),
    ...(mintAuthorityAddress ? { mintAuthorityAddress } : {}),
    ...(ticker ? { ticker } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    tokenAccountAddresses: accountAddresses,
  };
  return next;
}

export function normalizeKnownTokens(value: unknown): KnownTokenRecord[] {
  if (!Array.isArray(value)) return [];

  const records = new Map<string, KnownTokenRecord>();
  for (const candidate of value.slice(0, MAX_KNOWN_RECORDS)) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as {
      mintAddress?: unknown;
      label?: unknown;
      walletAddress?: unknown;
      creatorAddress?: unknown;
      mintAuthorityAddress?: unknown;
      ticker?: unknown;
      decimals?: unknown;
      tokenAccountAddresses?: unknown;
    };
    if (typeof raw.mintAddress !== "string") continue;

    let mintAddress: string;
    try {
      mintAddress = normalizeAddress(raw.mintAddress, "Mint address");
    } catch {
      continue;
    }

    const accountAddresses: string[] = [];
    if (Array.isArray(raw.tokenAccountAddresses)) {
      for (const address of raw.tokenAccountAddresses.slice(
        0,
        MAX_ACCOUNTS_PER_MINT,
      )) {
        if (typeof address !== "string") continue;
        try {
          accountAddresses.push(
            normalizeAddress(address, "Token account address"),
          );
        } catch {
          // Ignore malformed public references from storage.
        }
      }
    }

    let walletAddress: string | undefined;
    if (typeof raw.walletAddress === "string" && raw.walletAddress.trim()) {
      try {
        walletAddress = normalizeAddress(raw.walletAddress, "Wallet address");
      } catch {
        // Ignore malformed wallet reference.
      }
    }

    const creatorAddress = normalizeStoredAddress(raw.creatorAddress);
    const mintAuthorityAddress = normalizeStoredAddress(
      raw.mintAuthorityAddress,
    );
    const ticker = normalizeTicker(raw.ticker);
    const decimals = normalizeDecimals(raw.decimals);
    const recordKey = `${walletAddress ?? ""}:${mintAddress}`;
    const existing = records.get(recordKey);
    if (
      !existing &&
      Array.from(records.values()).filter(
        (record) => record.walletAddress === walletAddress,
      ).length >= MAX_KNOWN_MINTS
    ) {
      continue;
    }
    const label = existing?.label ?? normalizeLabel(raw.label);
    records.set(recordKey, {
      mintAddress,
      ...(label ? { label } : {}),
      ...(walletAddress ? { walletAddress } : {}),
      ...(creatorAddress ? { creatorAddress } : {}),
      ...(mintAuthorityAddress ? { mintAuthorityAddress } : {}),
      ...(ticker ? { ticker } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      tokenAccountAddresses: Array.from(
        new Set([
          ...(existing?.tokenAccountAddresses ?? []),
          ...accountAddresses,
        ]),
      ).slice(0, MAX_ACCOUNTS_PER_MINT),
    });
  }
  return Array.from(records.values());
}

export function createdTokensForWallet(
  records: KnownTokenRecord[],
  walletAddress: string,
): KnownTokenRecord[] {
  let canonicalWallet: string;
  try {
    canonicalWallet = normalizeAddress(walletAddress, "Wallet address");
  } catch {
    return [];
  }
  return normalizeKnownTokens(records).filter(
    (record) => record.walletAddress === canonicalWallet,
  );
}

export function loadCreatedTokensForWallet(
  storage: Pick<Storage, "getItem">,
  walletAddress: string,
): KnownTokenRecord[] {
  return createdTokensForWallet(loadKnownTokens(storage), walletAddress);
}

export function normalizeBackupCreatedTokens(
  value: unknown,
  walletAddress: string,
): KnownTokenRecord[] {
  return createdTokensForWallet(
    value as KnownTokenRecord[],
    walletAddress,
  )
    .slice(0, MAX_BACKUP_CREATED_TOKENS)
    .map((record) => ({
      ...record,
      tokenAccountAddresses: record.tokenAccountAddresses.slice(
        0,
        MAX_BACKUP_ACCOUNTS_PER_MINT,
      ),
    }));
}

export function mergeCreatedTokenRecords(
  records: KnownTokenRecord[],
  incoming: KnownTokenRecord[],
  walletAddress: string,
): KnownTokenRecord[] {
  const canonicalWallet = normalizeAddress(walletAddress, "Wallet address");
  let merged = normalizeKnownTokens(records);
  for (const record of createdTokensForWallet(incoming, canonicalWallet)) {
    const existing = merged.find(
      (candidate) =>
        candidate.walletAddress === canonicalWallet &&
        candidate.mintAddress === record.mintAddress,
    );
    merged = upsertKnownToken(merged, {
      ...record,
      walletAddress: canonicalWallet,
      label: existing?.label ?? record.label,
    });
    for (const tokenAccountAddress of record.tokenAccountAddresses) {
      merged = upsertKnownToken(merged, {
        ...record,
        walletAddress: canonicalWallet,
        label: existing?.label ?? record.label,
        tokenAccountAddress,
      });
    }
  }
  return merged;
}

export function restoreCreatedTokenCatalog(
  storage: Pick<Storage, "getItem" | "setItem">,
  walletAddress: string,
  incoming: KnownTokenRecord[],
): KnownTokenRecord[] {
  const merged = mergeCreatedTokenRecords(
    loadKnownTokens(storage),
    incoming,
    walletAddress,
  );
  saveKnownTokens(storage, merged);
  return merged;
}

export function tokenDisplayLabels(
  localName: string | undefined,
  ticker: string | undefined,
  fallback = "Saved token",
): { primary: string; secondary?: string } {
  const name = normalizeLabel(localName);
  const validTicker = normalizeTicker(ticker);
  const primary = name ?? validTicker ?? fallback;
  return {
    primary,
    ...(validTicker && validTicker !== primary
      ? { secondary: validTicker }
      : {}),
  };
}

export class LatestRequestTracker {
  private latestRequest = 0;

  begin(): number {
    this.latestRequest += 1;
    return this.latestRequest;
  }

  isCurrent(request: number): boolean {
    return request === this.latestRequest;
  }

  invalidate(): void {
    this.latestRequest += 1;
  }
}

function normalizeAddress(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  try {
    return Pubkey.from(normalized).toThruFmt();
  } catch {
    throw new Error(`${label} is not a valid Thru address.`);
  }
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return validateTokenName(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalAddress(
  value: unknown,
  label: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return normalizeAddress(value, label);
}

function normalizeStoredAddress(value: unknown): string | undefined {
  try {
    return normalizeOptionalAddress(value, "Stored address");
  } catch {
    return undefined;
  }
}

function normalizeTicker(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const ticker = validateTokenTicker(value);
    return ticker === value ? ticker : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDecimals(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  try {
    return validateTokenDecimals(value);
  } catch {
    return undefined;
  }
}

export function classifyPortfolio(
  portfolio: import('./thru-token').TokenPortfolioItem[],
  activeWalletAddress?: string
) {
  const activeAssets = [];
  const externalAssets = [];

  for (const item of portfolio) {
    if (item.walletAddress && activeWalletAddress && item.walletAddress !== activeWalletAddress) {
      externalAssets.push(item);
      continue;
    }
    if (
      item.error &&
      activeWalletAddress &&
      item.walletAddress === activeWalletAddress
    ) {
      activeAssets.push(item);
      continue;
    }
    const isCreator = activeWalletAddress && item.mint?.creator === activeWalletAddress;
    const isMintAuthority = activeWalletAddress && item.mint?.mintAuthority === activeWalletAddress;

    if (isCreator || isMintAuthority) {
      activeAssets.push(item);
    } else {
      externalAssets.push(item);
    }
  }

  return { activeAssets, externalAssets };
}

/** Catalog ownership and token-account ownership are distinct, never inferred from a name. */
export function isWalletAsset(item: TokenPortfolioItem, wallet: string): boolean {
  return item.walletAddress === wallet && (Boolean(item.mint &&
    (item.mint.creator === wallet || item.mint.mintAuthority === wallet)) ||
    item.tokenAccounts.some((account) => account.state?.owner === wallet && account.state.mint === item.mintAddress) ||
    Boolean(item.error));
}
export function tokenSendSources(item: TokenPortfolioItem | undefined, wallet: string, now = Date.now()) {
  if (!item?.mint || item.error || !Number.isInteger(item.mint.decimals) || item.mint.decimals < 0 || item.mint.decimals > 18) return [];
  return item.tokenAccounts.filter((account) => account.state?.owner === wallet && account.state.mint === item.mintAddress &&
    !account.state.isFrozen && !account.error && account.discoveryRead !== "cached" &&
    (account.discoveryRead === undefined || (account.discoveryAuthoritative === true &&
      item.discoveryAuthoritative === true && account.verifiedAt !== undefined && now >= account.verifiedAt && now - account.verifiedAt <= 60_000)));
}
/** Display eligibility must expire even when the portfolio object is unchanged. */
export function observeTokenSourceExpiry(item: TokenPortfolioItem | undefined, wallet: string, onExpire: () => void) {
  const now = Date.now();
  const deadlines = tokenSendSources(item, wallet, now).flatMap((source) =>
    source.discoveryRead === "live" && source.verifiedAt !== undefined ? [source.verifiedAt + 60_001 - now] : []);
  if (!deadlines.length) return () => {};
  const timer = setTimeout(onExpire, Math.max(1, Math.min(...deadlines)));
  return () => clearTimeout(timer);
}
export function tokenSendSourceAllowed(item: TokenPortfolioItem | undefined, wallet: string, address: string) {
  return tokenSendSources(item, wallet).some((source) => source.address === address);
}
export function tokenReadBalance(item: TokenPortfolioItem, wallet: string): string {
  const owned = item.tokenAccounts.filter((candidate) => candidate.state?.owner === wallet && candidate.state.mint === item.mintAddress);
  const account = owned.find((candidate) => candidate.discoveryRead !== "cached") ?? owned[0];
  if (!account?.state || !item.mint || !Number.isInteger(item.mint.decimals)) return "Unavailable";
  return (account.discoveryRead === "cached" ? "Cached: " : "") + formatRawAmount(account.state.amount, item.mint.decimals);
}
export function tokenSourceRestriction(item: TokenPortfolioItem | undefined, wallet: string): string | null {
  if (!item) return null;
  if (tokenSendSources(item, wallet).length) return null;
  if (!item.mint) return "Mint decimals and token state must be verified before sending.";
  if (item.mint.decimals > 18) return "This token's decimals are not supported by the existing send engine.";
  return "No verified sendable source account is available. Cached or provisional holdings require authoritative reads before sending.";
}
export function mergeWalletPortfolio(created: TokenPortfolioItem[], snapshots: VerifiedHolding[], live: VerifiedHolding[], wallet: string): TokenPortfolioItem[] {
  const result = new Map(created.map((item) => [item.mintAddress, item]));
  const liveGroups = new Map(live.map((group) => [group.mintAddress, group]));
  for (const group of snapshots) {
    const prior = result.get(group.mintAddress), current = liveGroups.get(group.mintAddress);
    const freshMint = current?.mintSlot === group.mintSlot && current?.mintSeq === group.mintSeq;
    const currentAccounts = new Map(current?.accounts.map((account) => [account.address, account]) ?? []);
    const accounts = new Map(prior?.tokenAccounts.map((account) => [account.address, account]) ?? []);
    for (const account of group.accounts) {
      if (accounts.get(account.address)?.state && !accounts.get(account.address)?.error) continue; // Existing freshly-read created sources retain their policy.
      const observed = currentAccounts.get(account.address);
      const fresh = !!observed && observed.slot === account.slot && observed.seq === account.seq && freshMint;
      accounts.set(account.address, { address: account.address, state: account.state,
        discoveryRead: fresh ? "live" : "cached", discoveryAuthoritative: fresh && account.finality === "authoritative",
        verifiedAt: account.verifiedAt });
    }
    result.set(group.mintAddress, { ...prior, mintAddress: group.mintAddress, walletAddress: wallet,
      mint: prior?.mint ?? group.mint, tokenAccounts: [...accounts.values()],
      discoveryAuthoritative: freshMint && group.mintFinality === "authoritative",
      ...(prior?.mint && !prior.error ? {} : { error: undefined, discoveryRead: freshMint ? "live" : "cached" }) });
  }
  return [...result.values()].filter((item) => isWalletAsset(item, wallet));
}
