import assert from "node:assert/strict";
import test from "node:test";
import { Pubkey } from "@thru/sdk";
import { THRU_NETWORK } from "../lib/thru/network";
import { discoveryCacheKey, loadDiscoveryCache, mergeDiscoveryHoldings, saveDiscoveryCache, type DiscoveryCache } from "../lib/token/discovery-cache";
import { DISCOVERY_PROGRAM, type VerifiedHolding } from "../lib/token/discovery";
import { isWalletAsset, mergeWalletPortfolio, observeTokenSourceExpiry, tokenReadBalance, tokenSendSources, tokenSendSourceAllowed, tokenSourceRestriction, TOKEN_PORTFOLIO_STORAGE_KEY } from "../lib/token/portfolio";
import { validateTransferPreflight } from "../lib/token/operations";

// Synthetic public identities. No wallet keys or network operations.
const address = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
const wallet = address(10), other = address(11), mintAddress = address(12), custom = address(13);
function holding(accountAddress = custom, amount = 1_234_567n): VerifiedHolding {
  return { mintAddress, mint: { creator: other, mintAuthority: other, freezeAuthority: null,
    hasFreezeAuthority: false, decimals: 6, supply: (1n << 64n) - 1n, ticker: "RCV" },
    mintFinality: "authoritative", mintSlot: "100", mintSeq: "1", verifiedAt: 1000,
    accounts: [{ address: accountAddress, state: { owner: wallet, mint: mintAddress, amount, isFrozen: false },
      finality: "authoritative", verifiedAt: 1000, slot: "100", seq: "1" }] };
}
function cache(holdings = [holding()]): DiscoveryCache {
  return { version: 1, walletAddress: wallet, network: THRU_NETWORK.storageScope, chainId: THRU_NETWORK.expectedChainId,
    holdings, continuation: { version: 1, walletAddress: wallet, network: THRU_NETWORK.storageScope,
      program: DISCOVERY_PROGRAM, cursor: "page2", seenCursors: ["page2"], pendingAddresses: [address(14)], inventoryExhausted: false }, savedAt: 1000 };
}
function memory() {
  const data = new Map<string, string>(); let writes = 0;
  return { data, get writes() { return writes; }, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; data.set(key, value); } };
}
test("public cache round-trips exact BigInt values and safe continuation in a separate wallet/network key", () => {
  const storage = memory(); const original = cache();
  assert.equal(saveDiscoveryCache(storage, original), "ok");
  assert.deepEqual(loadDiscoveryCache(storage, wallet).value, original);
  assert.match(discoveryCacheKey(wallet), /betanet:2/);
  assert.notEqual(discoveryCacheKey(wallet), discoveryCacheKey(other));
  assert.equal(loadDiscoveryCache(storage, other).status, "absent");
  assert.equal(storage.getItem(TOKEN_PORTFOLIO_STORAGE_KEY), null);
});
test("whitelist serialization cannot leak unexpected object fields into discovery storage", () => {
  const storage = memory(); const input = cache();
  Object.assign(input, { privateKey: "synthetic-field-not-a-secret", mnemonic: "synthetic-field-not-a-secret" });
  Object.assign(input.holdings[0].mint, { password: "synthetic-field-not-a-secret" });
  assert.equal(saveDiscoveryCache(storage, input), "ok");
  assert.doesNotMatch(storage.getItem(discoveryCacheKey(wallet)) ?? "", /privateKey|mnemonic|password|synthetic-field/);
});
test("corrupt JSON is ignored without deleting or rewriting any catalog", () => {
  const storage = memory(); storage.data.set(discoveryCacheKey(wallet), "{bad json");
  storage.data.set(TOKEN_PORTFOLIO_STORAGE_KEY, "existing-created-catalog");
  assert.equal(loadDiscoveryCache(storage, wallet).status, "corrupt");
  assert.equal(storage.writes, 0); assert.equal(storage.getItem(TOKEN_PORTFOLIO_STORAGE_KEY), "existing-created-catalog");
});
for (const problem of ["network", "chain", "wallet", "version", "owner", "mint", "decimals", "duplicate", "unexpected", "continuation"] as const) {
  test("untrusted discovery cache rejects " + problem, () => {
    const storage = memory(); saveDiscoveryCache(storage, cache());
    const row = JSON.parse(storage.getItem(discoveryCacheKey(wallet))!);
    if (problem === "network") row.network = "alphanet:1";
    if (problem === "chain") row.chainId = 1;
    if (problem === "wallet") row.walletAddress = other;
    if (problem === "version") row.version = 2;
    if (problem === "owner") row.holdings[0].accounts[0].state.owner = other;
    if (problem === "mint") row.holdings[0].accounts[0].state.mint = other;
    if (problem === "decimals") delete row.holdings[0].mint.decimals;
    if (problem === "duplicate") row.holdings[0].accounts.push(row.holdings[0].accounts[0]);
    if (problem === "unexpected") row.extra = true;
    if (problem === "continuation") row.continuation.walletAddress = other;
    storage.data.set(discoveryCacheKey(wallet), JSON.stringify(row));
    assert.equal(loadDiscoveryCache(storage, wallet).status, "corrupt");
  });
}
test("SecurityError and quota failures return safe unavailable results without affecting created records", () => {
  const denied = { getItem: () => { throw new DOMException("details", "SecurityError"); }, setItem: () => { throw new Error("must not run"); } };
  assert.equal(loadDiscoveryCache(denied, wallet).status, "unavailable");
  assert.equal(saveDiscoveryCache(denied, cache()), "unavailable");
  const storage = memory(); saveDiscoveryCache(storage, cache()); const before = storage.getItem(discoveryCacheKey(wallet));
  const quota = { getItem: storage.getItem, setItem: () => { throw new DOMException("details", "QuotaExceededError"); } };
  assert.equal(saveDiscoveryCache(quota, cache([holding(address(15))])), "unavailable");
  assert.equal(storage.getItem(discoveryCacheKey(wallet)), before);
});
test("partial and empty scans merge additively even when separate consumers finish out of order", () => {
  const storage = memory();
  saveDiscoveryCache(storage, cache());
  saveDiscoveryCache(storage, cache([holding(address(15), 10n)]));
  saveDiscoveryCache(storage, cache([]));
  const found = loadDiscoveryCache(storage, wallet).value!.holdings[0];
  assert.deepEqual(found.accounts.map((a) => a.address), [custom, address(15)]);
  assert.equal(found.accounts[0].state.amount, 1_234_567n);
});
test("stale account versions cannot overwrite newer public balances", () => {
  const latest = holding(); latest.accounts[0].slot = "102"; latest.accounts[0].state.amount = 20n;
  const old = holding(); old.accounts[0].slot = "101";
  assert.equal(mergeDiscoveryHoldings([latest], [old])[0].accounts[0].state.amount, 20n);
});
test("oversized cache fails with limited status without overwriting a prior snapshot", () => {
  const storage = memory(); saveDiscoveryCache(storage, cache()); const before = storage.getItem(discoveryCacheKey(wallet));
  const tooMany = Array.from({ length: 129 }, (_, i) => ({ ...holding(address(i + 30)), mintAddress: address(i + 30) }));
  assert.equal(saveDiscoveryCache(storage, cache(tooMany)), "limited");
  assert.equal(storage.getItem(discoveryCacheKey(wallet)), before);
});
test("reload/offline cache displays historical holdings but cannot grant Send eligibility", () => {
  const storage = memory(); saveDiscoveryCache(storage, cache());
  const item = mergeWalletPortfolio([], loadDiscoveryCache(storage, wallet).value!.holdings, [], wallet)[0];
  assert.equal(isWalletAsset(item, wallet), true); assert.equal(isWalletAsset(item, other), false);
  assert.equal(item.discoveryRead, "cached"); assert.equal(tokenReadBalance(item, wallet), "Cached: 1.234567");
  assert.deepEqual(tokenSendSources(item, wallet, 1000), []);
  assert.match(tokenSourceRestriction(item, wallet) ?? "", /Cached or provisional/);
});
test("failed persistence and offline transition retain the session's public snapshot as stale", () => {
  const session = [holding()];
  const denied = { getItem: () => { throw new DOMException("unavailable", "SecurityError"); } };
  const retained = mergeDiscoveryHoldings(loadDiscoveryCache(denied, wallet).value?.holdings ?? [], session);
  const offline = mergeWalletPortfolio([], retained, [], wallet)[0];
  assert.equal(offline.tokenAccounts[0].state?.amount, 1_234_567n);
  assert.equal(offline.discoveryRead, "cached"); assert.deepEqual(tokenSendSources(offline, wallet), []);
});
test("only authoritative recent live reads enable a received custom source; multiple balances are never summed", () => {
  const first = holding(), second = holding(address(15), 9_000_000n);
  const merged = mergeDiscoveryHoldings([first], [second]);
  const item = mergeWalletPortfolio([], merged, merged, wallet)[0];
  assert.equal(item.mint?.creator, other); assert.equal(tokenSendSources(item, wallet, 1000).length, 2);
  assert.deepEqual(tokenSendSources(item, wallet, 1000).map((a) => a.address), [custom, address(15)]);
  assert.equal(tokenReadBalance(item, wallet), "1.234567"); // Not 10.234567, and not the default-derived address.
  assert.deepEqual(tokenSendSources(item, wallet, 100_000), []);
  assert.deepEqual(tokenSendSources(item, wallet, 500), []);
});
test("unchanged received-asset metadata expires its UI eligibility and click-time guard without RPC", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const group = holding(), asset = mergeWalletPortfolio([], [group], [group], wallet)[0];
  let expirations = 0, allowed = tokenSendSourceAllowed(asset, wallet, custom);
  const stop = observeTokenSourceExpiry(asset, wallet, () => {
    expirations++; allowed = tokenSendSourceAllowed(asset, wallet, custom);
  });
  assert.equal(allowed, true);
  t.mock.timers.tick(60_000); assert.equal(allowed, true); assert.equal(expirations, 0);
  t.mock.timers.tick(1); assert.equal(allowed, false); assert.equal(expirations, 1);
  assert.equal(asset.tokenAccounts[0].verifiedAt, 1000); // No mutation or refetch needed.
  assert.equal(tokenSendSourceAllowed(asset, other, custom), false);
  stop();
});
test("source expiry timer cleanup cancels unmounted/old-wallet UI updates", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const group = holding(), asset = mergeWalletPortfolio([], [group], [group], wallet)[0];
  let oldWalletUpdates = 0;
  const stop = observeTokenSourceExpiry(asset, wallet, () => oldWalletUpdates++);
  stop(); t.mock.timers.tick(60_001);
  assert.equal(oldWalletUpdates, 0);
  const cached = mergeWalletPortfolio([], [group], [], wallet)[0];
  observeTokenSourceExpiry(cached, wallet, () => oldWalletUpdates++);
  t.mock.timers.tick(60_001); assert.equal(oldWalletUpdates, 0);
});
test("provisional account or mint, frozen source and unsupported decimals all disable Send", () => {
  for (const condition of ["account", "mint", "frozen", "decimals"] as const) {
    const group = holding();
    if (condition === "account") group.accounts[0].finality = "provisional";
    if (condition === "mint") group.mintFinality = "provisional";
    if (condition === "frozen") group.accounts[0].state.isFrozen = true;
    if (condition === "decimals") group.mint.decimals = 255;
    const item = mergeWalletPortfolio([], [group], [group], wallet)[0];
    assert.deepEqual(tokenSendSources(item, wallet, 1000), [], condition);
  }
});
test("unknown mint/balance is unavailable rather than zero and created-token source policy remains unchanged", () => {
  const unknown = { mintAddress, walletAddress: wallet, tokenAccounts: [{ address: custom }] };
  assert.equal(tokenReadBalance(unknown, wallet), "Unavailable"); assert.deepEqual(tokenSendSources(unknown, wallet), []);
  const group = holding(); group.mint.creator = wallet;
  const created = { mintAddress, walletAddress: wallet, label: "Created label", mint: group.mint,
    tokenAccounts: [{ address: custom, state: group.accounts[0].state }] };
  const merged = mergeWalletPortfolio([created], [group], [], wallet)[0];
  assert.equal(merged.label, "Created label"); assert.deepEqual(tokenSendSources(merged, wallet), created.tokenAccounts);
});
test("invalid runtime decimals cannot grant Send eligibility or display an invented zero balance", () => {
  const group = holding(); group.mint.decimals = Number.NaN;
  const asset = { mintAddress, walletAddress: wallet, mint: group.mint, tokenAccounts: [{ address: custom, state: group.accounts[0].state }] };
  assert.deepEqual(tokenSendSources(asset, wallet), []); assert.equal(tokenReadBalance(asset, wallet), "Unavailable");
});
test("received custom source passes the real existing transfer preflight without creator authority", () => {
  const group = holding();
  const raw = validateTransferPreflight({ activeWalletAddress: wallet, mintAddress, mint: group.mint,
    sourceAddress: custom, destinationAddress: address(15), source: group.accounts[0].state,
    destination: { owner: other, mint: mintAddress, amount: 0n, isFrozen: false }, amount: "1" });
  assert.equal(raw, 1_000_000n);
  assert.throws(() => validateTransferPreflight({ activeWalletAddress: other, mintAddress, mint: group.mint,
    sourceAddress: custom, destinationAddress: address(15), source: group.accounts[0].state,
    destination: { owner: other, mint: mintAddress, amount: 0n, isFrozen: false }, amount: "1" }), /owned/i);
});
