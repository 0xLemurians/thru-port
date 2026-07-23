import { Pubkey } from "@thru/sdk";

export const TOKEN_PORTFOLIO_STORAGE_KEY =
  "thru.tokenStudio.alphanet.knownTokens.v1";

const MAX_KNOWN_MINTS = 64;
const MAX_ACCOUNTS_PER_MINT = 128;

export interface KnownTokenRecord {
  mintAddress: string;
  label?: string;
  tokenAccountAddresses: string[];
}

export function loadKnownTokens(
  storage: Pick<Storage, "getItem">,
): KnownTokenRecord[] {
  const raw = storage.getItem(TOKEN_PORTFOLIO_STORAGE_KEY);
  if (!raw) return [];
  try {
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
  },
): KnownTokenRecord[] {
  const mintAddress = normalizeAddress(input.mintAddress, "Mint address");
  const tokenAccountAddress = input.tokenAccountAddress?.trim()
    ? normalizeAddress(input.tokenAccountAddress, "Token account address")
    : undefined;
  const label = normalizeLabel(input.label);
  const normalized = normalizeKnownTokens(records);
  const existingIndex = normalized.findIndex(
    (record) => record.mintAddress === mintAddress,
  );

  if (existingIndex === -1) {
    if (normalized.length >= MAX_KNOWN_MINTS) {
      throw new Error(`At most ${MAX_KNOWN_MINTS} known mints can be stored.`);
    }
    return [
      ...normalized,
      {
        mintAddress,
        ...(label ? { label } : {}),
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
    ...(label ? { label } : {}),
    tokenAccountAddresses: accountAddresses,
  };
  return next;
}

export function normalizeKnownTokens(value: unknown): KnownTokenRecord[] {
  if (!Array.isArray(value)) return [];

  const records = new Map<string, KnownTokenRecord>();
  for (const candidate of value.slice(0, MAX_KNOWN_MINTS)) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as {
      mintAddress?: unknown;
      label?: unknown;
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

    records.set(mintAddress, {
      mintAddress,
      ...(typeof raw.label === "string" && normalizeLabel(raw.label)
        ? { label: normalizeLabel(raw.label) }
        : {}),
      tokenAccountAddresses: Array.from(new Set(accountAddresses)),
    });
  }
  return Array.from(records.values());
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
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.slice(0, 64);
}
