import { Pubkey } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { formatRawAmount, type MintAccountInfo } from "@thru/programs/token";
import { tokenSendSources, type KnownTokenRecord } from "../token/portfolio";
import type { TokenPortfolioAccount, TokenPortfolioItem } from "../token/thru-token";
import type { DiscoveryContinuation, DiscoveryResult, VerifiedHolding } from "../token/discovery";
import { formatNativeThruAmount, NATIVE_THRU_BALANCE_UNIT } from "../wallet/native-balance";

/** Public observations only. This model is neither a read service nor Send authority. */
export interface PortfolioScope {
  readonly networkId: string;
  readonly chainId: number;
  readonly walletAddress: string;
}
export type PortfolioNetworkStatus = "Online" | "Degraded" | "Checking" | "Offline";
export interface Observation {
  readonly source: "rpc" | "cache" | "unknown";
  readonly observedAt: number | null;
  readonly finality: "authoritative" | "provisional" | "unknown";
  readonly consensus: string | null;
  readonly version: { readonly slot: string | null; readonly seq: string | null } | null;
}
export type Freshness = "fresh" | "stale" | "unknown";
export type NativeObservation = {
  readonly scope: PortfolioScope;
  readonly observation: Observation;
} & ({ readonly availability: "available"; readonly rawBalance: bigint } |
  { readonly availability: "unavailable"; readonly rawBalance: null });
export interface NativeAsset {
  readonly kind: "native";
  readonly id: string;
  readonly rawBalance: bigint | null;
  readonly availability: "available" | "unavailable";
  readonly unit: typeof NATIVE_THRU_BALANCE_UNIT;
  readonly observation: Observation;
  readonly freshness: Freshness;
}
export interface AssetRelationship {
  readonly status: "observed" | "not-observed" | "unknown";
  readonly observation: Observation;
}
export type SourceBlockReason = "unavailable" | "wrong-owner" | "wrong-mint" | "frozen" |
  "unsupported-decimals" | "cached" | "provisional" | "expired-or-unknown" | "conflicting-observations" | "network-unavailable";
export interface TokenSourceAccount {
  readonly address: string;
  readonly mintAddress: string;
  readonly decodedMintAddress: string | null;
  readonly decodedOwner: string | null;
  readonly rawAmount: bigint | null;
  readonly frozen: boolean | null;
  readonly availability: "available" | "unavailable";
  readonly error: string | null;
  readonly observation: Observation;
  readonly freshness: Freshness;
  readonly eligibility: { readonly kind: "preflight-candidate" } |
    { readonly kind: "blocked"; readonly reason: SourceBlockReason };
}
export interface DiscoveryCoverage {
  readonly state: "partial" | "exhausted" | "unavailable";
  readonly continuation: DiscoveryContinuation | null;
  readonly unresolvedCandidates: number | null;
  readonly observedAt: number | null;
  /** Exhaustion describes the accessible RPC cursor, never all wallet holdings. */
  readonly completeWalletHoldings: false;
}
export interface TokenAsset {
  readonly kind: "token";
  readonly id: string;
  readonly programAddress: string;
  readonly mintAddress: string;
  readonly decimals: number | null;
  readonly metadata: {
    readonly localLabel: { readonly value: string; readonly provenance: "local" } | null;
    readonly ticker: { readonly value: string; readonly observation: Observation } | null;
  };
  readonly relationships: {
    readonly walletOwned: AssetRelationship;
    readonly creator: AssetRelationship;
    readonly mintAuthority: AssetRelationship;
    readonly savedReference: boolean;
  };
  readonly sources: readonly TokenSourceAccount[];
  readonly observation: Observation;
  readonly freshness: Freshness;
  readonly coverage: DiscoveryCoverage;
  readonly availability: "available" | "unavailable";
}
/** Produced from the existing validated portfolio pipeline, not raw RPC/JSON. */
export interface TokenPortfolioSnapshot {
  readonly scope: PortfolioScope;
  readonly programAddress: string;
  readonly items: readonly TokenPortfolioItem[];
  readonly records: readonly KnownTokenRecord[];
  readonly discovery: DiscoveryResult | null;
  /** Existing cache/live snapshots; never fetched by the model. */
  readonly holdings?: readonly VerifiedHolding[];
  readonly liveHoldings?: readonly VerifiedHolding[];
}
export interface WalletPortfolio {
  readonly scope: PortfolioScope;
  readonly native: NativeAsset;
  readonly tokens: readonly TokenAsset[];
  readonly coverage: DiscoveryCoverage;
  readonly rejectedTokenSnapshot: boolean;
}

const U64_MAX = (1n << 64n) - 1n;
const DISPLAY_FRESHNESS_MS = 60_000;
export function unknownObservation(): Observation {
  return { source: "unknown", observedAt: null, finality: "unknown", consensus: null, version: null };
}
export function copyPortfolioScope(scope: PortfolioScope): PortfolioScope {
  return { networkId: scope.networkId, chainId: scope.chainId, walletAddress: scope.walletAddress };
}
export function portfolioScopeKey(scope: PortfolioScope): string {
  return `${scope.networkId}:${scope.chainId}:${scope.walletAddress}`;
}
export function samePortfolioScope(a: PortfolioScope, b: PortfolioScope): boolean {
  return a.networkId === b.networkId && a.chainId === b.chainId && a.walletAddress === b.walletAddress;
}
function canonical(value: string | undefined): value is string {
  try { return typeof value === "string" && Pubkey.isThruFmt(value) && Pubkey.from(value).toThruFmt() === value; }
  catch { return false; }
}
function validScope(scope: PortfolioScope): boolean {
  return /^[a-z][a-z0-9-]*$/.test(scope.networkId) && Number.isSafeInteger(scope.chainId) &&
    scope.chainId > 0 && canonical(scope.walletAddress);
}
function timestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function uint(value: unknown): value is bigint { return typeof value === "bigint" && value >= 0n && value <= U64_MAX; }
function text(value: string | undefined, limit: number): string | null {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= limit &&
    !/[\u0000-\u001f\u007f\ufffd]/u.test(value) ? value : null;
}
export function observationFreshness(observation: Observation, now: number): Freshness {
  if (observation.source === "cache") return "stale";
  const at = timestamp(observation.observedAt);
  if (observation.source !== "rpc" || at === null || !Number.isFinite(now) || at > now) return "unknown";
  return now - at <= DISPLAY_FRESHNESS_MS ? "fresh" : "stale";
}
function copyObservation(value: Observation): Observation {
  return { source: value.source, observedAt: timestamp(value.observedAt), finality: value.finality,
    consensus: value.consensus, version: value.version ? { slot: value.version.slot, seq: value.version.seq } : null };
}
function observationOf(row: Pick<TokenPortfolioAccount, "discoveryRead" | "discoveryAuthoritative" | "verifiedAt">): Observation {
  return { source: row.discoveryRead === "live" ? "rpc" : row.discoveryRead === "cached" ? "cache" : "unknown",
    observedAt: timestamp(row.verifiedAt), finality: row.discoveryRead === "live"
      ? row.discoveryAuthoritative === true ? "authoritative" : "provisional" : "unknown",
    consensus: null, version: null };
}
function sameMint(a: MintAccountInfo, b: MintAccountInfo): boolean {
  return a.creator === b.creator && a.mintAuthority === b.mintAuthority && a.decimals === b.decimals &&
    a.ticker === b.ticker && a.supply === b.supply && a.freezeAuthority === b.freezeAuthority && a.hasFreezeAuthority === b.hasFreezeAuthority;
}
function versionOf(slot: string, seq: string): Observation["version"] {
  // Discovery historically used slot=0 for absent version context. Keep that ambiguous value unknown.
  return { slot: /^[1-9]\d*$/.test(slot) ? slot : null, seq: /^\d+$/.test(seq) ? seq : null };
}
function mintObservation(item: TokenPortfolioItem, holdings: readonly VerifiedHolding[]): Observation {
  const basic = observationOf(item);
  if (!item.discoveryRead || !item.mint) return basic;
  const mint = item.mint;
  const matching = holdings.find((g) => g.mintAddress === item.mintAddress && sameMint(g.mint, mint));
  return matching ? { ...basic, observedAt: timestamp(matching.verifiedAt),
    finality: basic.finality === "provisional" ? "provisional" : matching.mintFinality,
    version: versionOf(matching.mintSlot, matching.mintSeq) } : basic;
}
function sourceObservation(item: TokenPortfolioItem, source: TokenPortfolioAccount, holdings: readonly VerifiedHolding[]): Observation {
  const basic = observationOf(source);
  if (!source.discoveryRead || !source.state) return basic;
  const state = source.state;
  const matching = holdings.find((g) => g.mintAddress === item.mintAddress)?.accounts.find((a) =>
    a.address === source.address && a.verifiedAt === source.verifiedAt && a.state.owner === state.owner &&
    a.state.mint === state.mint && a.state.amount === state.amount && a.state.isFrozen === state.isFrozen);
  return matching ? { ...basic, finality: basic.finality === "provisional" ? "provisional" : matching.finality,
    version: versionOf(matching.slot, matching.seq) } : basic;
}
function coverageOf(scope: PortfolioScope, discovery: DiscoveryResult | null): DiscoveryCoverage {
  const empty: DiscoveryCoverage = { state: "unavailable", continuation: null, unresolvedCandidates: null,
    observedAt: null, completeWalletHoldings: false };
  if (!discovery || discovery.walletAddress !== scope.walletAddress || discovery.network !== `${scope.networkId}:${scope.chainId}`) return empty;
  const cursor = discovery.continuation;
  if (cursor && (cursor.walletAddress !== scope.walletAddress || cursor.network !== discovery.network ||
      cursor.program !== BOOTSTRAP_PROGRAM_ADDRESSES.token)) return empty;
  return { state: discovery.state, continuation: cursor ? { version: cursor.version, network: cursor.network,
    walletAddress: cursor.walletAddress, program: cursor.program, cursor: cursor.cursor,
    seenCursors: [...cursor.seenCursors], pendingAddresses: [...cursor.pendingAddresses], inventoryExhausted: cursor.inventoryExhausted } : null,
    unresolvedCandidates: discovery.candidateReadFailures, observedAt: timestamp(discovery.verifiedAt), completeWalletHoldings: false };
}
function mintValid(mint: MintAccountInfo | undefined): mint is MintAccountInfo {
  return !!mint && canonical(mint.creator) && canonical(mint.mintAuthority) && uint(mint.supply) &&
    Number.isInteger(mint.decimals) && mint.decimals >= 0 && mint.decimals <= 255;
}
function relation(matches: boolean | null, observation: Observation): AssetRelationship {
  return { status: matches === null ? "unknown" : matches ? "observed" : "not-observed", observation };
}
function sourceModel(item: TokenPortfolioItem, source: TokenPortfolioAccount, scope: PortfolioScope,
  now: number, online: boolean, holdings: readonly VerifiedHolding[], eligible: ReadonlySet<TokenPortfolioAccount>): TokenSourceAccount {
  const state = source.state;
  const observation = sourceObservation(item, source, holdings);
  const valid = !!state && uint(state.amount) && typeof state.isFrozen === "boolean" &&
    state.owner === scope.walletAddress && state.mint === item.mintAddress && !source.error;
  // Delegate candidate selection to the unchanged existing policy, per original item.
  // Never combine a mint from one observation with eligibility from another.
  const candidate = valid && mintValid(item.mint) && eligible.has(source);
  let reason: SourceBlockReason = "expired-or-unknown";
  if (!online) reason = "network-unavailable";
  else if (state && state.owner !== scope.walletAddress) reason = "wrong-owner";
  else if (state && state.mint !== item.mintAddress) reason = "wrong-mint";
  else if (!valid || !mintValid(item.mint) || item.error) reason = "unavailable";
  else if (state.isFrozen) reason = "frozen";
  else if (item.mint.decimals > 18) reason = "unsupported-decimals";
  else if (source.discoveryRead === "cached") reason = "cached";
  else if (source.discoveryRead === "live" && (!source.discoveryAuthoritative || !item.discoveryAuthoritative)) reason = "provisional";
  return { address: source.address, mintAddress: item.mintAddress,
    decodedMintAddress: canonical(state?.mint) ? state.mint : null,
    decodedOwner: canonical(state?.owner) ? state.owner : null, rawAmount: valid ? state.amount : null,
    frozen: state && typeof state.isFrozen === "boolean" ? state.isFrozen : null,
    availability: valid ? "available" : "unavailable", error: source.error ? "Token account data is unavailable." : null,
    observation, freshness: online ? observationFreshness(observation, now) : "stale",
    eligibility: candidate && online ? { kind: "preflight-candidate" } : { kind: "blocked", reason } };
}
function sameSource(a: TokenSourceAccount, b: TokenSourceAccount): boolean {
  // Compare public values explicitly; never enumerate unexpected input fields.
  return a.rawAmount === b.rawAmount && a.decodedOwner === b.decodedOwner && a.decodedMintAddress === b.decodedMintAddress &&
    a.frozen === b.frozen && a.error === b.error && a.observation.source === b.observation.source &&
    a.observation.observedAt === b.observation.observedAt && a.observation.finality === b.observation.finality &&
    a.eligibility.kind === b.eligibility.kind && (a.eligibility.kind !== "blocked" ||
      (b.eligibility.kind === "blocked" && a.eligibility.reason === b.eligibility.reason));
}

/** Pure projection. No reads, timers, storage, transactions, or private account objects. */
export function buildWalletPortfolio(input: {
  scope: PortfolioScope; native: NativeObservation | null; tokens: TokenPortfolioSnapshot | null;
  networkStatus: PortfolioNetworkStatus; now: number;
}): WalletPortfolio {
  const scope = copyPortfolioScope(input.scope);
  if (!validScope(scope)) throw new Error("Invalid public portfolio scope.");
  const online = input.networkStatus === "Online" || input.networkStatus === "Degraded";
  const nativeRead = input.native && samePortfolioScope(scope, input.native.scope) ? input.native : null;
  const nativeObservation = nativeRead ? copyObservation(nativeRead.observation) : unknownObservation();
  const rawBalance = online && nativeRead?.availability === "available" && uint(nativeRead.rawBalance) ? nativeRead.rawBalance : null;
  const native: NativeAsset = { kind: "native", id: `${portfolioScopeKey(scope)}:native`, rawBalance,
    availability: rawBalance === null ? "unavailable" : "available", unit: NATIVE_THRU_BALANCE_UNIT,
    observation: nativeObservation, freshness: online ? observationFreshness(nativeObservation, input.now) : "stale" };
  const snapshot = input.tokens && samePortfolioScope(scope, input.tokens.scope) &&
    input.tokens.programAddress === BOOTSTRAP_PROGRAM_ADDRESSES.token ? input.tokens : null;
  const coverage = coverageOf(scope, snapshot?.discovery ?? null);
  const groups = new Map<string, TokenPortfolioItem[]>();
  for (const item of snapshot?.items ?? []) {
    if (item.walletAddress !== scope.walletAddress || !canonical(item.mintAddress)) continue;
    const group = groups.get(item.mintAddress) ?? [];
    group.push(item); groups.set(item.mintAddress, group);
  }
  const records = (snapshot?.records ?? []).filter((r) => r.walletAddress === scope.walletAddress && canonical(r.mintAddress));
  for (const record of records) if (!groups.has(record.mintAddress)) groups.set(record.mintAddress, []);
  const tokens: TokenAsset[] = [];
  for (const [mintAddress, items] of groups) {
    const record = records.find((r) => r.mintAddress === mintAddress);
    const verified = items.filter((item) => !item.error && mintValid(item.mint));
    const first = verified[0];
    const mint = first?.mint;
    const conflict = verified.some((item) => item.mint?.decimals !== mint?.decimals || item.mint?.ticker !== mint?.ticker ||
      item.mint?.creator !== mint?.creator || item.mint?.mintAuthority !== mint?.mintAuthority);
    const usableMint = mint && !conflict ? mint : undefined;
    // The merged portfolio does not carry mint timestamps/versions. Do not borrow
    // a scan completion time or a possibly older discovery mint's metadata.
    const observation = first && !conflict ? mintObservation(first,
      (first.discoveryRead === "live" ? snapshot?.liveHoldings : snapshot?.holdings) ?? []) : unknownObservation();
    const sources = new Map<string, TokenSourceAccount>();
    for (const item of items) {
      const eligible = new Set(tokenSendSources(item, scope.walletAddress, input.now));
      for (const source of item.tokenAccounts) {
        if (!canonical(source.address)) continue;
        const next = sourceModel(item, source, scope, input.now, online,
          (source.discoveryRead === "live" ? snapshot?.liveHoldings : snapshot?.holdings) ?? [], eligible);
        const prior = sources.get(source.address);
        if (prior && !sameSource(prior, next)) sources.set(source.address, { ...prior, rawAmount: null, availability: "unavailable",
          error: "Conflicting token account observations.", observation: unknownObservation(), freshness: "unknown",
          eligibility: { kind: "blocked", reason: "conflicting-observations" } });
        else sources.set(source.address, next);
      }
    }
    if (!usableMint) for (const [address, source] of sources) sources.set(address, { ...source,
      eligibility: { kind: "blocked", reason: conflict ? "conflicting-observations" : "unavailable" } });
    const allSources = [...sources.values()];
    const owned = allSources.filter((s) => s.availability === "available" && s.decodedOwner === scope.walletAddress);
    const localLabel = text(record?.label ?? items.find((item) => item.label)?.label, 64);
    const ticker = text(usableMint?.ticker, 8);
    tokens.push({ kind: "token", id: `${portfolioScopeKey(scope)}:token:${BOOTSTRAP_PROGRAM_ADDRESSES.token}:${mintAddress}`,
      programAddress: BOOTSTRAP_PROGRAM_ADDRESSES.token, mintAddress, decimals: usableMint?.decimals ?? null,
      metadata: { localLabel: localLabel ? { value: localLabel, provenance: "local" } : null,
        ticker: ticker ? { value: ticker, observation } : null },
      relationships: { walletOwned: relation(owned.length ? true : null, owned.length === 1 ? owned[0].observation : unknownObservation()),
        creator: relation(usableMint ? usableMint.creator === scope.walletAddress : null, observation),
        mintAuthority: relation(usableMint ? usableMint.mintAuthority === scope.walletAddress : null, observation), savedReference: !!record },
      sources: allSources, observation, freshness: online ? observationFreshness(observation, input.now) : "stale", coverage,
      availability: usableMint ? "available" : "unavailable" });
  }
  return { scope, native, tokens, coverage, rejectedTokenSnapshot: input.tokens !== null && snapshot === null };
}

export function nativeBalanceDisplay(asset: NativeAsset): string {
  return asset.rawBalance === null ? "Unavailable" : `${formatNativeThruAmount(asset.rawBalance)} ${asset.unit}`;
}
/** Per-account only. There is intentionally no subtotal or MAX selector. */
export function tokenSourceDisplay(asset: TokenAsset, source: TokenSourceAccount): string {
  if (!asset.sources.includes(source) || source.mintAddress !== asset.mintAddress || source.rawAmount === null || asset.decimals === null) return "Unavailable";
  return formatRawAmount(source.rawAmount, asset.decimals);
}
export function observationNotices(observation: Observation, now: number): string[] {
  const messages: string[] = [];
  if (observation.source === "cache") messages.push("Cached public observation; live state has not been verified.");
  const freshness = observationFreshness(observation, now);
  if (freshness === "stale") messages.push("This observation is stale.");
  if (freshness === "unknown") messages.push("Observation freshness is unknown.");
  if (observation.finality === "provisional") messages.push("Provisional account state; not finalized or proof of spendability.");
  if (observation.finality === "unknown") messages.push("Account finality is unknown.");
  return messages;
}
export function coverageNotice(coverage: DiscoveryCoverage): string {
  return coverage.state === "exhausted"
    ? "The available RPC inventory cursor is exhausted; complete wallet holdings are not guaranteed."
    : coverage.state === "partial" ? "Discovery is partial; additional or unresolved accounts may exist."
    : "Live discovery is unavailable; saved references do not prove current holdings.";
}
