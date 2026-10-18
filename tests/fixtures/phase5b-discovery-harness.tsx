// Isolated, OFFLINE public test fixture. Never import this module from application code.
// The deterministic fixture key below is deliberately public, never funded or used on-chain.
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Account, ConsensusStatus, Pubkey, type ListAccountsOptions } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { TokenAccount, TokenMintAccount } from "@thru/programs/token";
import AppFlow from "../../components/AppFlow";
import { accountFromPrivateKey } from "../../lib/wallet/thru-wallet";
import { restorePersistedWallet, saveAndVerifyPersistedWallet } from "../../lib/wallet/persistent-wallet";
import { discoveryCacheKey } from "../../lib/token/discovery-cache";
import { saveKnownTokens } from "../../lib/token/portfolio";

const address = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
export const publicIds = {
  wallet: "", otherWallet: "", outsider: address(60), mint: address(61), sameTickerMint: address(62),
  first: address(63), custom: address(64), second: address(65), provisional: address(66),
  malformed: address(67), unresolved: address(68), last: address(69), foreign: address(70),
  creatorMint: address(71), authorityMint: address(72), savedMint: address(73), walletBToken: address(74), unknown: address(75),
};

export type DiscoveryScenario = "rich" | "clean" | "rate-limit" | "timeout" | "old-version" | "wrong-program" | "malformed-mint" | "unknown-token" | "zero-token";
type Health = "Online" | "Degraded" | "Offline";
interface PublicStats {
  inventory: number; inventoryTokens: (string | null)[]; inventoryPageSizes: number[];
  creatorHistory: number; activityHistory: number; accountGets: number; nativeGets: number;
  getsByAddress: Record<string, number>; health: number; derivations: number; forbidden: number;
  inventoryFiltersValid: boolean; apiUrlsValid: boolean; abortedRequests: number;
}
export interface Phase5BDiscoveryQA {
  ids: typeof publicIds;
  stats(): PublicStats;
  recover(): void;
  scenario(value: DiscoveryScenario): void;
  health(value: Health): void;
  native(value: string | null): void;
  storage(value: "normal" | "quota" | "denied"): void;
  cache(): { exists: boolean; mintCount: number; sourceCount: number; pending: number; cursor: string | null; containsSecretFields: boolean };
  deferInventory(): void;
  releaseInventory(): void;
  foreignCache(): void;
  foreignCachePreserved(): boolean;
  switchFixtureWallet(): Promise<void>;
  remount(): void;
  unmount(): void;
}
export interface Phase5BTransport {
  list(options: ListAccountsOptions, signal?: AbortSignal): Promise<{ accounts: Account[]; page?: { nextPageToken?: string } }>;
  get(address: string, signal?: AbortSignal): Promise<Account>;
  history(wallet: string, options?: { filter?: unknown }): Promise<{ transactions: never[] }>;
  height(): Promise<{ finalized: bigint; locallyExecuted: bigint; clusterExecuted: bigint }>;
  derive(): void;
  deny(): never;
  url(url: unknown): void;
}
declare global { interface Window {
  phase5bDiscovery: Phase5BDiscoveryQA;
  phase5bTransport: Phase5BTransport;
  phase5bDiscoveryConfig?: { scenario?: DiscoveryScenario; native?: string | null };
  phase5bDiscoveryReady?: boolean;
} }

const stats: PublicStats = { inventory: 0, inventoryTokens: [], inventoryPageSizes: [], creatorHistory: 0,
  activityHistory: 0, accountGets: 0, nativeGets: 0, getsByAddress: {}, health: 0, derivations: 0,
  forbidden: 0, inventoryFiltersValid: true, apiUrlsValid: true, abortedRequests: 0 };
let scenario: DiscoveryScenario = window.phase5bDiscoveryConfig?.scenario ?? "rich";
let healthy: Health = "Online";
let nativeBalance: string | null = window.phase5bDiscoveryConfig?.native === undefined ? "0" : window.phase5bDiscoveryConfig.native;
let recovered = false, holdInventory = false;
let releases: (() => void)[] = [];
let root: Root | null = null;
let storageMode: "normal" | "quota" | "denied" = "normal";
const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
Storage.prototype.getItem = function (key: string) {
  if (storageMode === "denied" && key.startsWith("thru.token")) throw new DOMException("Synthetic denied storage", "SecurityError");
  return originalGet.call(this, key);
};
Storage.prototype.setItem = function (key: string, value: string) {
  if (storageMode !== "normal" && key.startsWith("thru.token")) throw new DOMException("Synthetic public cache failure", storageMode === "quota" ? "QuotaExceededError" : "SecurityError");
  return originalSet.call(this, key, value);
};

function envelope(publicAddress: string, data: Uint8Array, status = ConsensusStatus.FINALIZED, slot = 100n): Account {
  return new Account({ address: Pubkey.from(publicAddress), meta: { version: 1,
    owner: Pubkey.from(BOOTSTRAP_PROGRAM_ADDRESSES.token), dataSize: data.length, seq: 1n, nonce: 1n, balance: 0n,
    flags: { isProgram: false, isPrivileged: false, isUncompressable: false, isEphemeral: false,
      isDeleted: false, isNew: false, isCompressed: false } },
    data: { data, compressed: false }, consensusStatus: status, versionContext: { slot, seq: 1n } });
}
function token(publicAddress: string, owner = publicIds.wallet, mint = publicIds.mint, raw = 7_000_000n,
  status = ConsensusStatus.FINALIZED, slot = 100n): Account {
  return envelope(publicAddress, TokenAccount.builder().set_mint(Pubkey.from(mint).toBytes())
    .set_owner(Pubkey.from(owner).toBytes()).set_amount(raw).set_is_frozen(0).build(), status, slot);
}
function mint(publicAddress: string): Account {
  const ticker = new Uint8Array(9); ticker.set([4, 83, 65, 77, 69]);
  return envelope(publicAddress, TokenMintAccount.builder().set_decimals(6).set_supply(20_000_000n)
    .set_creator(Pubkey.from(publicAddress === publicIds.creatorMint ? publicIds.wallet : publicIds.outsider).toBytes())
    .set_mint_authority(Pubkey.from(publicAddress === publicIds.authorityMint ? publicIds.wallet : publicIds.outsider).toBytes())
    .set_freeze_authority(new Uint8Array(32)).set_has_freeze_authority(0).set_ticker(ticker).build());
}
function missing(): never { throw Object.assign(new Error("Synthetic absent public fixture"), { code: 5 }); }
function lookup(publicAddress: string, snapshot = scenario): Account {
  if (publicAddress === publicIds.savedMint) return missing();
  if ([publicIds.mint, publicIds.sameTickerMint, publicIds.creatorMint, publicIds.authorityMint].includes(publicAddress)) {
    const full = mint(publicAddress);
    return snapshot === "malformed-mint" && publicAddress === publicIds.mint
      ? new Account({ ...full, data: { compressed: false, data: new Uint8Array(114) } }) : full;
  }
  if (publicAddress === publicIds.first) {
    const full = token(publicAddress, publicIds.wallet, publicIds.mint, snapshot === "old-version" ? 99_000_000n : snapshot === "zero-token" ? 0n : 7_000_000n,
      ConsensusStatus.FINALIZED, snapshot === "old-version" ? 99n : 100n);
    return snapshot === "wrong-program" ? new Account({ ...full, meta: { ...full.meta!, owner: Pubkey.from(publicIds.outsider) } }) : full;
  }
  if (publicAddress === publicIds.custom) return token(publicAddress, publicIds.wallet, publicIds.mint, snapshot === "zero-token" ? 0n : 9_000_000n);
  if (publicAddress === publicIds.second) return token(publicAddress, publicIds.wallet, publicIds.sameTickerMint, 3_000_000n);
  if (publicAddress === publicIds.provisional) return token(publicAddress, publicIds.wallet, publicIds.sameTickerMint, 2_000_000n, ConsensusStatus.INCLUDED);
  if (publicAddress === publicIds.foreign) return token(publicAddress, publicIds.outsider);
  if (publicAddress === publicIds.walletBToken) return token(publicAddress, publicIds.otherWallet, publicIds.sameTickerMint, 5_000_000n);
  if (publicAddress === publicIds.last || (recovered && (publicAddress === publicIds.malformed || publicAddress === publicIds.unresolved))) return token(publicAddress, publicIds.wallet, publicIds.mint, 1_000_000n);
  if (publicAddress === publicIds.malformed) return envelope(publicAddress, new Uint8Array(72));
  return missing();
}
function inventory(cursor: string | null, snapshot: DiscoveryScenario) {
  const metaOnly = (id: string) => { const full = lookup(id, snapshot); return new Account({ ...full, data: undefined }); };
  if (snapshot !== "rich") return { accounts: [lookup(publicIds.first, snapshot), lookup(publicIds.custom, snapshot),
    lookup(publicIds.second, snapshot), lookup(publicIds.walletBToken, snapshot)] };
  if (!cursor) return { accounts: [lookup(publicIds.first), lookup(publicIds.custom), lookup(publicIds.second),
    lookup(publicIds.foreign), metaOnly(publicIds.malformed), lookup(publicIds.walletBToken)], page: { nextPageToken: "phase5b-page-2" } };
  if (cursor === "phase5b-page-2") return { accounts: [lookup(publicIds.first), lookup(publicIds.provisional),
    new Account({ ...token(publicIds.unresolved), data: undefined })], page: { nextPageToken: "phase5b-page-3" } };
  return { accounts: [lookup(publicIds.last)] };
}
window.phase5bTransport = {
  async list(options, signal) {
    stats.inventory++; stats.inventoryTokens.push(options.page?.pageToken ?? null);
    stats.inventoryPageSizes.push(options.page?.pageSize ?? 0);
    stats.inventoryFiltersValid &&= options.filter?.expression === "account.meta.owner.value == params.owner_bytes && account.meta.data_size == uint(73)" &&
      options.minConsensus === ConsensusStatus.INCLUDED;
    signal?.addEventListener("abort", () => { stats.abortedRequests++; }, { once: true });
    const snapshot = scenario, cursor = options.page?.pageToken ?? null;
    if (holdInventory) { holdInventory = false; await new Promise<void>((resolve) => releases.push(resolve)); }
    if (snapshot === "timeout") return new Promise<never>(() => {});
    if (snapshot === "rate-limit") throw Object.assign(new Error("Synthetic RPC transport details must not reach UI"), { code: 429 });
    return inventory(cursor, snapshot);
  },
  async get(publicAddress) {
    stats.accountGets++; stats.getsByAddress[publicAddress] = (stats.getsByAddress[publicAddress] ?? 0) + 1;
    if (publicAddress === publicIds.wallet || publicAddress === publicIds.otherWallet) {
      stats.nativeGets++;
      if (nativeBalance === null) return missing();
      const base = envelope(publicAddress, new Uint8Array());
      return new Account({ ...base, meta: { ...base.meta!, owner: Pubkey.from(BOOTSTRAP_PROGRAM_ADDRESSES.eoa), balance: BigInt(nativeBalance) } });
    }
    return lookup(publicAddress);
  },
  async history(_wallet, options) {
    if (options?.filter) stats.creatorHistory++; else stats.activityHistory++;
    return { transactions: [] };
  },
  async height() {
    stats.health++;
    if (healthy === "Offline") throw new Error("Synthetic offline transport");
    return healthy === "Degraded" ? { finalized: 0n, locallyExecuted: 0n, clusterExecuted: 0n }
      : { finalized: 100n, locallyExecuted: 101n, clusterExecuted: 101n };
  },
  derive() { stats.derivations++; },
  deny() { stats.forbidden++; throw new Error("Phase 5B forbids signing, key generation, faucet and submission"); },
  url(url) { stats.apiUrlsValid &&= url === "https://rpc.betanet.thru.org"; },
};

function mount() { root = createRoot(document.getElementById("root")!); root.render(<AppFlow />); }
function unmount() { root?.unmount(); root = null; }
async function seed(second = false) {
  // Public deterministic TEST-ONLY material; never serialize or expose it to the runner.
  const raw = new Uint8Array(32).fill(second ? 82 : 81);
  const account = await accountFromPrivateKey(raw);
  raw.fill(0);
  try { await saveAndVerifyPersistedWallet(account, { setupPending: false }); }
  finally { account.privateKey.fill(0); }
}
async function bootstrap() {
  const a = await accountFromPrivateKey(new Uint8Array(32).fill(81));
  const b = await accountFromPrivateKey(new Uint8Array(32).fill(82));
  publicIds.wallet = a.address; publicIds.otherWallet = b.address;
  a.privateKey.fill(0); b.privateKey.fill(0);
  const existing = await restorePersistedWallet();
  if (existing) existing.privateKey.fill(0); else {
    await seed();
    saveKnownTokens(localStorage, [
      { walletAddress: publicIds.wallet, mintAddress: publicIds.creatorMint, tokenAccountAddresses: scenario === "unknown-token" ? [publicIds.unknown] : [], label: "Creator fixture" },
      { walletAddress: publicIds.wallet, mintAddress: publicIds.authorityMint, tokenAccountAddresses: [], label: "Authority fixture" },
      { walletAddress: publicIds.wallet, mintAddress: publicIds.savedMint, tokenAccountAddresses: [], label: "Saved fixture" },
    ]);
  }
  window.phase5bDiscovery = {
    ids: publicIds, stats: () => ({ ...stats, inventoryTokens: [...stats.inventoryTokens], inventoryPageSizes: [...stats.inventoryPageSizes], getsByAddress: { ...stats.getsByAddress } }),
    recover: () => { recovered = true; }, scenario: (value) => { scenario = value; },
    health: (value) => { healthy = value; document.dispatchEvent(new Event("visibilitychange")); },
    native: (value) => { nativeBalance = value; document.dispatchEvent(new Event("visibilitychange")); },
    storage: (value) => { storageMode = value; },
    cache: () => {
      const raw = originalGet.call(localStorage, discoveryCacheKey(publicIds.wallet));
      const value = raw ? JSON.parse(raw) : null;
      return { exists: !!value, mintCount: value?.holdings?.length ?? 0,
        sourceCount: value?.holdings?.reduce((n: number, group: { accounts: unknown[] }) => n + group.accounts.length, 0) ?? 0,
        pending: value?.continuation?.pendingAddresses?.length ?? 0, cursor: value?.continuation?.cursor ?? null,
        containsSecretFields: !!raw && /privateKey|mnemonic|ciphertext|password|seed/.test(raw) };
    },
    deferInventory: () => { holdInventory = true; },
    releaseInventory: () => { const pending = releases; releases = []; pending.forEach((resolve) => resolve()); },
    foreignCache: () => {
      const cacheKey = discoveryCacheKey(publicIds.wallet), encoded = originalGet.call(localStorage, cacheKey);
      if (!encoded) throw new Error("Missing public fixture cache");
      const value = JSON.parse(encoded); value.network = "alphanet:1"; value.chainId = 1;
      const foreign = JSON.stringify(value);
      originalSet.call(localStorage, cacheKey, foreign);
      originalSet.call(localStorage, `thru.tokenDiscovery.alphanet:1.v1.${publicIds.wallet}`, foreign);
      originalSet.call(localStorage, "phase5b-foreign-checksum", foreign);
    },
    foreignCachePreserved: () => originalGet.call(localStorage, `thru.tokenDiscovery.alphanet:1.v1.${publicIds.wallet}`) === originalGet.call(localStorage, "phase5b-foreign-checksum"),
    async switchFixtureWallet() { unmount(); await seed(true); mount(); },
    remount: () => { unmount(); mount(); }, unmount,
  };
  // Ensures unrelated preferences survive public discovery/cache operations.
  if (!originalGet.call(localStorage, "phase5b-unrelated")) originalSet.call(localStorage, "phase5b-unrelated", "preserved");
  mount(); window.phase5bDiscoveryReady = true;
}
void bootstrap();
