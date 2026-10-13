import { AccountView, ConsensusStatus, Filter, FilterParamValue, PageRequest, Pubkey, type Account, type ListAccountsOptions } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { TokenAccount, TokenMintAccount, parseMintAccountData, parseTokenAccountData, type MintAccountInfo, type TokenAccountInfo } from "@thru/programs/token";
import { createThruAccountReader } from "../thru/client";
import { THRU_NETWORK } from "../thru/network";

export const DISCOVERY_PROGRAM = BOOTSTRAP_PROGRAM_ADDRESSES.token;
export const TOKEN_ACCOUNT_BYTES = 73;
export const TOKEN_MINT_BYTES = 115;
export type DiscoveryState = "partial" | "exhausted" | "unavailable";
export type DiscoveryCode = "rpc-unavailable" | "rate-limited" | "timeout" | "aborted" | "not-found" |
  "invalid-address" | "invalid-owner" | "invalid-layout" | "invalid-mint" | "unsupported-state" | "cursor-cycle" | "budget-limit";
export interface DiscoveryDiagnostic { stage: "inventory" | "account" | "mint"; code: DiscoveryCode; address?: string }
export interface HoldingAccount {
  address: string; state: TokenAccountInfo; verifiedAt: number; finality: "provisional" | "authoritative";
  slot: string; seq: string;
}
export interface VerifiedHolding {
  mintAddress: string; mint: MintAccountInfo; mintFinality: "provisional" | "authoritative";
  mintSlot: string; mintSeq: string; verifiedAt: number; accounts: HoldingAccount[];
}
export interface DiscoveryContinuation {
  version: 1; network: string; walletAddress: string; program: string;
  cursor: string | null; seenCursors: string[]; pendingAddresses: string[]; inventoryExhausted: boolean;
}
export interface DiscoveryResult {
  walletAddress: string; network: string; holdings: VerifiedHolding[]; state: DiscoveryState;
  continuation: DiscoveryContinuation | null; pagesInspected: number; accountsInspected: number;
  candidateReadFailures: number; verifiedAt: number; diagnostics: DiscoveryDiagnostic[];
}
export interface DiscoveryReader {
  list(options: ListAccountsOptions): Promise<{ accounts: Account[]; page?: { nextPageToken?: string } }>;
  get(address: string): Promise<Account>;
}
export interface DiscoveryOptions {
  signal?: AbortSignal; continuation?: DiscoveryContinuation | null; reader?: DiscoveryReader;
  maxPages?: number; maxAccounts?: number; pageSize?: number; concurrency?: number;
  requestTimeoutMs?: number; totalTimeoutMs?: number; now?: () => number;
}
class DiscoveryReadError extends Error {
  constructor(readonly code: DiscoveryCode) { super(code); }
}
export function canonicalDiscoveryAddress(value: string): string {
  if (!Pubkey.isThruFmt(value) || Pubkey.from(value).toThruFmt() !== value) throw new DiscoveryReadError("invalid-address");
  return value;
}
export function validContinuation(value: DiscoveryContinuation, wallet: string): DiscoveryContinuation {
  if (value.version !== 1 || value.network !== THRU_NETWORK.storageScope || value.walletAddress !== wallet ||
      value.program !== DISCOVERY_PROGRAM || typeof value.inventoryExhausted !== "boolean" ||
      (value.cursor !== null && (typeof value.cursor !== "string" || !value.cursor || value.cursor.length > 8192)) ||
      !Array.isArray(value.seenCursors) || value.seenCursors.length > 128 ||
      value.seenCursors.some((cursor) => typeof cursor !== "string" || !cursor || cursor.length > 8192) ||
      !Array.isArray(value.pendingAddresses) || value.pendingAddresses.length > 256) throw new DiscoveryReadError("invalid-layout");
  value.pendingAddresses.forEach(canonicalDiscoveryAddress);
  if (new Set(value.seenCursors).size !== value.seenCursors.length ||
      new Set(value.pendingAddresses).size !== value.pendingAddresses.length) throw new DiscoveryReadError("invalid-layout");
  return { ...value, seenCursors: [...value.seenCursors], pendingAddresses: [...value.pendingAddresses] };
}
/** Refresh starts inventory again but never loses unresolved public candidates. */
export function discoveryContinuationForRequest(previous: DiscoveryContinuation | null | undefined, wallet: string, resume: boolean) {
  if (!previous) return null;
  const valid = validContinuation(previous, wallet);
  return resume ? valid : { ...valid, cursor: null, seenCursors: [], inventoryExhausted: false };
}
function limit(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
function codeOf(error: unknown): DiscoveryCode {
  if (error instanceof DiscoveryReadError) return error.code;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === 8 || code === 429) return "rate-limited";
  if (code === 4) return "timeout";
  if (code === 5) return "not-found";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "rpc-unavailable";
}
function validateEnvelope(account: Account, expected: string, size: number) {
  if (account.address?.toThruFmt() !== expected) throw new DiscoveryReadError("invalid-address");
  const meta = account.meta;
  if (meta?.owner?.toThruFmt() !== DISCOVERY_PROGRAM) throw new DiscoveryReadError("invalid-owner");
  if (!meta.flags || [meta.flags.isDeleted, meta.flags.isProgram, meta.flags.isEphemeral, meta.flags.isCompressed].some((flag) => flag !== false) ||
      typeof meta.flags.isNew !== "boolean" || account.data?.compressed) throw new DiscoveryReadError("unsupported-state");
  if (![ConsensusStatus.INCLUDED, ConsensusStatus.CLUSTER_EXECUTED, ConsensusStatus.FINALIZED].includes(account.consensusStatus ?? ConsensusStatus.UNSPECIFIED)) {
    throw new DiscoveryReadError("unsupported-state");
  }
  if (meta.dataSize !== size || account.data?.data?.length !== size) throw new DiscoveryReadError("invalid-layout");
  if (typeof meta.seq !== "bigint" || meta.seq < 0n || (account.versionContext?.slot !== undefined &&
      (typeof account.versionContext.slot !== "bigint" || account.versionContext.slot < 0n))) throw new DiscoveryReadError("invalid-layout");
  return account.consensusStatus === ConsensusStatus.INCLUDED || meta.flags.isNew ? "provisional" as const : "authoritative" as const;
}
function version(account: Account) {
  return { slot: (account.versionContext?.slot ?? 0n).toString(), seq: (account.meta?.seq ?? 0n).toString() };
}
function validateMint(mint: MintAccountInfo) {
  if (!Number.isInteger(mint.decimals) || mint.decimals < 0 || mint.decimals > 255 ||
      typeof mint.supply !== "bigint" || mint.supply < 0n || mint.supply > (1n << 64n) - 1n ||
      typeof mint.ticker !== "string" || new TextEncoder().encode(mint.ticker).length > 8 ||
      /[\u0000-\u001f\u007f\ufffd]/u.test(mint.ticker)) throw new DiscoveryReadError("invalid-mint");
  canonicalDiscoveryAddress(mint.creator); canonicalDiscoveryAddress(mint.mintAuthority);
  if (mint.freezeAuthority) canonicalDiscoveryAddress(mint.freezeAuthority);
}

/** Account inventory, never account-history or a signing/submission API. */
export async function discoverWalletHoldings(walletInput: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const wallet = canonicalDiscoveryAddress(walletInput);
  const now = options.now ?? Date.now;
  const started = now();
  const maxPages = limit(options.maxPages, 2, 8), maxAccounts = limit(options.maxAccounts, 64, 256);
  const pageSize = limit(options.pageSize, 32, 64), concurrency = limit(options.concurrency, 3, 4);
  const requestTimeout = limit(options.requestTimeoutMs, 4000, 10_000), totalTimeout = limit(options.totalTimeoutMs, 12_000, 30_000);
  const initial: DiscoveryContinuation = options.continuation ? validContinuation(options.continuation, wallet) : {
    version: 1, network: THRU_NETWORK.storageScope, walletAddress: wallet, program: DISCOVERY_PROGRAM,
    cursor: null, seenCursors: [], pendingAddresses: [], inventoryExhausted: false,
  };
  const scope = new AbortController();
  const abort = () => scope.abort();
  if (options.signal?.aborted) scope.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const totalTimer = setTimeout(() => scope.abort(), totalTimeout);
  const reader: DiscoveryReader = options.reader ?? (() => {
    const client = createThruAccountReader(scope.signal, requestTimeout);
    return { list: (query) => client.list(query), get: (address) => client.get(address, { view: AccountView.FULL }) };
  })();
  const pending = new Set(initial.pendingAddresses), seen = new Set(initial.seenCursors), attempted = new Set<string>();
  const rows = new Map<string, Account>(), requests = new Map<string, Promise<Account>>();
  const mints = new Map<string, Promise<{ mint: MintAccountInfo; finality: VerifiedHolding["mintFinality"]; slot: string; seq: string }>>();
  const holdings = new Map<string, VerifiedHolding>();
  const diagnostics: DiscoveryDiagnostic[] = [];
  let cursor = initial.cursor, exhausted = initial.inventoryExhausted, pages = 0, inspected = 0, failures = 0, inventoryFailed = false, throttled = false;
  const stopped = () => scope.signal.aborted || now() - started >= totalTimeout;
  const diagnostic = (stage: DiscoveryDiagnostic["stage"], error: unknown, address?: string) => {
    const code = codeOf(error);
    if (code === "rate-limited") throttled = true;
    if (diagnostics.length < 256) diagnostics.push({ stage, code, ...(address ? { address } : {}) });
  };
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    if (stopped()) throw new DiscoveryReadError(options.signal?.aborted ? "aborted" : "timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (stopped()) throw new DiscoveryReadError("aborted"); return work(); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DiscoveryReadError("timeout")), Math.min(requestTimeout, Math.max(1, totalTimeout - (now() - started))));
          rejectAbort = () => reject(new DiscoveryReadError(options.signal?.aborted ? "aborted" : "timeout"));
          scope.signal.addEventListener("abort", rejectAbort, { once: true });
        }),
      ]);
    } finally { clearTimeout(timer); if (rejectAbort) scope.signal.removeEventListener("abort", rejectAbort); }
  }
  const get = (address: string) => {
    let request = requests.get(address);
    if (!request) { request = bounded(() => reader.get(address)); requests.set(address, request); }
    return request;
  };
  async function process(address: string) {
    attempted.add(address); inspected++;
    try {
      let account = rows.get(address);
      if (!account?.data?.data) account = await get(address);
      const listed = rows.get(address);
      const listedSlot = listed?.versionContext?.slot, readSlot = account.versionContext?.slot;
      if (listedSlot !== undefined && readSlot !== undefined && (readSlot < listedSlot ||
          (readSlot === listedSlot && (account.meta?.seq ?? 0n) < (listed?.meta?.seq ?? 0n)))) {
        throw new DiscoveryReadError("unsupported-state");
      }
      const finality = validateEnvelope(account, address, TOKEN_ACCOUNT_BYTES);
      const tokenBytes = account.data?.data;
      if (!tokenBytes) throw new DiscoveryReadError("invalid-layout");
      const abi = TokenAccount.from_array(tokenBytes);
      if (!abi || abi.get_is_frozen() > 1) throw new DiscoveryReadError("invalid-layout");
      const state = parseTokenAccountData(account);
      canonicalDiscoveryAddress(state.owner); canonicalDiscoveryAddress(state.mint);
      if (state.owner !== wallet) { pending.delete(address); return; }
      let mintRequest = mints.get(state.mint);
      if (!mintRequest) {
        mintRequest = (async () => {
          const full = await get(state.mint);
          const mintFinality = validateEnvelope(full, state.mint, TOKEN_MINT_BYTES);
          const mintBytes = full.data?.data;
          if (!mintBytes) throw new DiscoveryReadError("invalid-mint");
          const mintAbi = TokenMintAccount.from_array(mintBytes);
          if (!mintAbi || mintAbi.get_has_freeze_authority() > 1 || mintAbi.get_ticker().get_length() > 8) throw new DiscoveryReadError("invalid-mint");
          const mint = parseMintAccountData(full); validateMint(mint);
          return { mint, finality: mintFinality, ...version(full) };
        })();
        mints.set(state.mint, mintRequest);
      }
      let verified;
      try { verified = await mintRequest; }
      catch (error) { diagnostic("mint", error, state.mint); throw error; }
      if (stopped()) throw new DiscoveryReadError("aborted");
      const verifiedAt = now();
      const existing = holdings.get(state.mint);
      const group: VerifiedHolding = existing ?? {
        mintAddress: state.mint, mint: verified.mint, mintFinality: verified.finality,
        mintSlot: verified.slot, mintSeq: verified.seq, verifiedAt, accounts: [],
      };
      group.accounts.push({ address, state, finality, verifiedAt, ...version(account) });
      holdings.set(state.mint, group);
      pending.delete(address);
    } catch (error) {
      failures++; diagnostic("account", error, address);
      // Even invalid/missing candidates remain explicit unresolved public references.
      // Retrying is a user-triggered READ; it can never emit a transaction.
    }
  }
  try {
    while (!stopped() && !throttled && inspected < maxAccounts) {
      const batch = [...pending].filter((address) => !attempted.has(address)).slice(0, maxAccounts - inspected);
      if (batch.length) {
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
          while (!stopped() && !throttled && index < batch.length) {
            const address = batch[index++]; await process(address);
          }
        }));
        continue;
      }
      if (exhausted || pages >= maxPages || seen.size >= 128) break;
      let page;
      try {
        page = await bounded(() => reader.list({
          view: AccountView.FULL, minConsensus: ConsensusStatus.INCLUDED,
          filter: new Filter({ expression: "account.meta.owner.value == params.owner_bytes && account.meta.data_size == uint(73)",
            params: { owner_bytes: FilterParamValue.bytes(Pubkey.from(DISCOVERY_PROGRAM).toBytes()) } }),
          page: new PageRequest({ pageSize: Math.min(pageSize, maxAccounts - inspected), pageToken: cursor ?? undefined }),
        }));
      } catch (error) { inventoryFailed = true; diagnostic("inventory", error); break; }
      pages++;
      if (!Array.isArray(page.accounts) || page.accounts.length > pageSize || pending.size + page.accounts.length > 256) {
        inventoryFailed = true; diagnostic("inventory", new DiscoveryReadError("invalid-layout")); break;
      }
      for (const row of page.accounts.slice(0, pageSize)) {
        try {
          const address = canonicalDiscoveryAddress(row.address.toThruFmt());
          if (!attempted.has(address)) { rows.set(address, row); pending.add(address); }
        } catch (error) { failures++; diagnostic("account", error); }
      }
      const next = page.page?.nextPageToken || null;
      if (next && (next.length > 8192 || next === cursor || seen.has(next))) {
        inventoryFailed = true; diagnostic("inventory", new DiscoveryReadError("cursor-cycle"));
        // Never resume a cyclic cursor. Restart inventory explicitly, retain failed candidates.
        cursor = null; exhausted = false; seen.clear(); break;
      }
      if (next) seen.add(next);
      cursor = next;
      exhausted = !next;
    }
    if (stopped()) diagnostic("inventory", new DiscoveryReadError(options.signal?.aborted ? "aborted" : "timeout"));
    const cursorBudgetReached = !exhausted && seen.size >= 128;
    if (cursorBudgetReached) diagnostic("inventory", new DiscoveryReadError("budget-limit"));
    const state: DiscoveryState = exhausted && pending.size === 0 && failures === 0 && !inventoryFailed && !stopped()
      ? "exhausted" : inventoryFailed && pages === 0 && inspected === 0 ? "unavailable" : "partial";
    return {
      walletAddress: wallet, network: THRU_NETWORK.storageScope, holdings: [...holdings.values()], state,
      // No non-progressing Continue action at the bounded cursor-history limit.
      // Unresolved candidates can still be retried; Refresh can restart inventory.
      continuation: state === "exhausted" || (cursorBudgetReached && pending.size === 0) ? null
        : { ...initial, cursor, seenCursors: [...seen], pendingAddresses: [...pending], inventoryExhausted: exhausted },
      pagesInspected: pages, accountsInspected: inspected, candidateReadFailures: failures, verifiedAt: now(), diagnostics,
    };
  } finally {
    clearTimeout(totalTimer); options.signal?.removeEventListener("abort", abort); scope.abort();
  }
}

/** Used by the hook and tests: old-wallet/unmounted completions cannot commit. */
export class DiscoveryRequestGuard {
  private scope = ""; private generation = 0; private controller: AbortController | null = null;
  setScope(scope: string) { if (scope !== this.scope) { this.cancel(); this.scope = scope; } }
  begin(scope: string) {
    this.setScope(scope); this.cancel();
    const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    return { controller, signal: controller.signal, isCurrent: () => this.scope === scope && generation === this.generation && !controller.signal.aborted };
  }
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
}

const flights = new Map<string, { controller: AbortController; promise: Promise<DiscoveryResult>; users: number }>();
const readerIds = new WeakMap<DiscoveryReader, number>();
let nextReaderId = 0;
/** Same-wallet/same-scan subscribers share work; one unmount cannot cancel another subscriber. */
export function discoverWalletHoldingsOnce(wallet: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  if (options.signal?.aborted) return Promise.reject(new DOMException("Discovery stopped", "AbortError"));
  if (options.reader && !readerIds.has(options.reader)) readerIds.set(options.reader, ++nextReaderId);
  const key = JSON.stringify([THRU_NETWORK.storageScope, wallet, options.continuation ?? null,
    options.maxPages, options.maxAccounts, options.pageSize, options.concurrency,
    options.requestTimeoutMs, options.totalTimeoutMs, options.reader ? readerIds.get(options.reader) : 0]);
  let flight = flights.get(key);
  if (flight?.controller.signal.aborted) { flights.delete(key); flight = undefined; }
  if (!flight) {
    const controller = new AbortController();
    const entry = { controller, users: 0, promise: discoverWalletHoldings(wallet, { ...options, signal: controller.signal }) };
    entry.promise = entry.promise.finally(() => {
      if (flights.get(key) === entry) flights.delete(key);
    });
    flight = entry; flights.set(key, entry);
  }
  const current = flight; current.users++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return; released = true;
      options.signal?.removeEventListener("abort", abort);
      if (--current.users === 0) current.controller.abort();
    };
    const abort = () => { release(); reject(new DOMException("Discovery stopped", "AbortError")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    current.promise.then((result) => { release(); resolve(result); }, (error: unknown) => { release(); reject(error); });
  });
}
