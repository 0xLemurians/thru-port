import assert from "node:assert/strict";
import test from "node:test";
import { Pubkey } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { buildWalletPortfolio, coverageNotice, nativeBalanceDisplay, observationNotices,
  tokenSourceDisplay, unknownObservation, type NativeObservation, type PortfolioScope,
  type TokenPortfolioSnapshot } from "../lib/portfolio/asset-model";
import { mergeWalletPortfolio, tokenSendSources } from "../lib/token/portfolio";
import { validateTransferPreflight } from "../lib/token/operations";
import type { TokenPortfolioItem } from "../lib/token/thru-token";
import type { DiscoveryResult, VerifiedHolding } from "../lib/token/discovery";

// Synthetic public addresses, not wallets or signing fixtures.
const address = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
const wallet = address(10), other = address(11), mint = address(12), source = address(13);
const scope: PortfolioScope = { networkId: "betanet", chainId: 2, walletAddress: wallet };
const now = 100_000;
function holding(): VerifiedHolding {
  return { mintAddress: mint, mint: { creator: other, mintAuthority: other, freezeAuthority: null,
    hasFreezeAuthority: false, ticker: "SAME", decimals: 6, supply: (1n << 64n) - 1n },
    mintFinality: "authoritative", mintSlot: "100", mintSeq: "2", verifiedAt: now,
    accounts: [{ address: source, state: { owner: wallet, mint, amount: 1_234_567n, isFrozen: false },
      finality: "authoritative", slot: "100", seq: "3", verifiedAt: now }] };
}
function snapshot(group = holding(), cached = false): TokenPortfolioSnapshot {
  const discovery: DiscoveryResult = { network: "betanet:2", walletAddress: wallet,
    state: "partial", holdings: [group], verifiedAt: now, pagesInspected: 1, accountsInspected: 1,
    candidateReadFailures: 2, diagnostics: [], continuation: { version: 1, network: "betanet:2", walletAddress: wallet,
      program: BOOTSTRAP_PROGRAM_ADDRESSES.token, cursor: "next", seenCursors: ["next"], pendingAddresses: [address(14), address(15)], inventoryExhausted: false } };
  return { scope, programAddress: BOOTSTRAP_PROGRAM_ADDRESSES.token, items: mergeWalletPortfolio([], [group], cached ? [] : [group], wallet),
    records: [], discovery, holdings: [group], liveHoldings: cached ? [] : [group] };
}
function model(tokens: TokenPortfolioSnapshot | null = snapshot(), time = now, native: NativeObservation | null = null) {
  return buildWalletPortfolio({ scope, tokens, native, now: time, networkStatus: "Online" });
}

test("native model distinguishes unavailable from verified zero and preserves raw uint64 units", () => {
  assert.equal(nativeBalanceDisplay(model(null).native), "Unavailable");
  for (const rawBalance of [0n, 1n, (1n << 64n) - 1n]) {
    const result = model(null, now, { scope, availability: "available", rawBalance,
      observation: { ...unknownObservation(), source: "rpc", observedAt: now, finality: "provisional", consensus: "INCLUDED" } });
    assert.equal(result.native.rawBalance, rawBalance);
    assert.equal(nativeBalanceDisplay(result.native), `${rawBalance} native units`);
    assert.equal(result.native.observation.finality, "provisional");
  }
});

test("holding, creator, mint authority and saved-reference relationships stay separate", () => {
  const held = model().tokens[0];
  assert.equal(held.relationships.walletOwned.status, "observed");
  assert.equal(held.relationships.creator.status, "not-observed");
  assert.equal(held.relationships.mintAuthority.status, "not-observed");
  assert.equal(held.relationships.savedReference, false);
  for (const role of ["creator", "mintAuthority"] as const) {
    const group = holding(); group.accounts = []; group.mint[role] = wallet;
    const input = snapshot(group);
    const asset = model(input).tokens[0];
    assert.equal(asset.relationships[role].status, "observed");
    assert.equal(asset.relationships.walletOwned.status, "unknown");
    assert.equal(asset.sources.length, 0);
  }
});

test("saved labels and unverified catalog decimals cannot become chain metadata or ownership", () => {
  const input = snapshot();
  const result = model({ ...input, items: [], records: [{ walletAddress: wallet, mintAddress: mint,
    label: "Local name", decimals: 6, ticker: "FAKE", creatorAddress: wallet, mintAuthorityAddress: wallet, tokenAccountAddresses: [source] }] });
  const asset = result.tokens[0];
  assert.equal(asset.relationships.savedReference, true);
  assert.equal(asset.relationships.creator.status, "unknown");
  assert.equal(asset.relationships.mintAuthority.status, "unknown");
  assert.equal(asset.relationships.walletOwned.status, "unknown");
  assert.deepEqual(asset.metadata.localLabel, { value: "Local name", provenance: "local" });
  assert.equal(asset.decimals, null); assert.equal(asset.metadata.ticker, null); assert.equal(asset.sources.length, 0);
});

test("same mint merges created and held records, deduplicates actual accounts, and keeps MAX per source", () => {
  const group = holding(); group.mint.creator = wallet;
  group.accounts.push({ ...group.accounts[0], address: address(20), state: { ...group.accounts[0].state, amount: 9_000_000n } });
  const input = snapshot(group);
  const result = model({ ...input, items: [...input.items, ...input.items], records: [{ walletAddress: wallet, mintAddress: mint,
    label: "Created", tokenAccountAddresses: [source] }] });
  assert.equal(result.tokens.length, 1);
  const asset = result.tokens[0];
  assert.equal(asset.relationships.creator.status, "observed"); assert.equal(asset.relationships.walletOwned.status, "observed");
  assert.equal(asset.relationships.savedReference, true);
  assert.deepEqual(asset.sources.map((a) => a.address), [source, address(20)]);
  assert.deepEqual(asset.sources.map((a) => tokenSourceDisplay(asset, a)), ["1.234567", "9"]);
  assert.deepEqual(tokenSendSources(input.items[0], wallet, now).map((a) => a.state?.amount), [1_234_567n, 9_000_000n]);
  assert.equal("totalBalance" in asset || "max" in asset, false);
});

test("identical tickers from different mints are distinct scoped identities", () => {
  const input = snapshot(), second = holding(); second.mintAddress = address(21);
  second.accounts[0].address = address(22); second.accounts[0].state.mint = second.mintAddress;
  const result = model({ ...input, items: [...input.items, ...snapshot(second).items] });
  assert.equal(result.tokens.length, 2);
  assert.notEqual(result.tokens[0].id, result.tokens[1].id);
  assert.match(result.tokens[0].id, /betanet:2:/);
  assert.notEqual(result.native.id, result.tokens[0].id);
});

test("conflicting duplicate balances fail closed instead of selecting an arbitrary spend source", () => {
  const input = snapshot(), conflicting = structuredClone(input.items[0]);
  conflicting.tokenAccounts[0].state!.amount = 999n;
  const asset = model({ ...input, items: [...input.items, conflicting, ...input.items] }).tokens[0];
  assert.equal(asset.sources.length, 1); assert.equal(asset.sources[0].rawAmount, null);
  assert.deepEqual(asset.sources[0].eligibility, { kind: "blocked", reason: "conflicting-observations" });
});

test("conflicting mint decimals never create a formatted amount or send candidate", () => {
  const input = snapshot(), conflicting = structuredClone(input.items[0]); conflicting.mint!.decimals = 9;
  const asset = model({ ...input, items: [...input.items, conflicting] }).tokens[0];
  assert.equal(asset.decimals, null); assert.equal(tokenSourceDisplay(asset, asset.sources[0]), "Unavailable");
  assert.equal(asset.sources[0].eligibility.kind, "blocked");
});

for (const mismatch of ["owner", "mint"] as const) {
  test(`wrong decoded ${mismatch} cannot claim a wallet holding or balance`, () => {
    const input = snapshot(), item = structuredClone(input.items[0]); item.tokenAccounts[0].state![mismatch] = other;
    const asset = model({ ...input, items: [item] }).tokens[0];
    assert.equal(asset.relationships.walletOwned.status, "unknown"); assert.equal(asset.sources[0].rawAmount, null);
    assert.deepEqual(asset.sources[0].eligibility, { kind: "blocked", reason: `wrong-${mismatch}` });
  });
}

for (const mismatch of ["wallet", "network", "chain", "program"] as const) {
  test(`${mismatch} mismatch cannot relabel a snapshot as the current wallet/network`, () => {
    const input = snapshot();
    const invalid = { ...input, scope: { ...scope, ...(mismatch === "wallet" ? { walletAddress: other } :
      mismatch === "network" ? { networkId: "alphanet" } : mismatch === "chain" ? { chainId: 1 } : {}) },
      programAddress: mismatch === "program" ? other : input.programAddress };
    assert.equal(model(invalid).rejectedTokenSnapshot, true); assert.deepEqual(model(invalid).tokens, []);
    assert.equal(model(invalid).coverage.state, "unavailable");
  });
}

test("unknown mint, amount and malformed numeric data remain unavailable rather than zero", () => {
  const input = snapshot(), item: TokenPortfolioItem = { walletAddress: wallet, mintAddress: mint, tokenAccounts: [{ address: source }] };
  let asset = model({ ...input, items: [item] }).tokens[0];
  assert.equal(asset.decimals, null); assert.equal(asset.sources[0].rawAmount, null);
  assert.equal(tokenSourceDisplay(asset, asset.sources[0]), "Unavailable");
  for (const raw of [-1n, 1n << 64n]) {
    const invalid = structuredClone(input.items[0]); invalid.tokenAccounts[0].state!.amount = raw;
    asset = model({ ...input, items: [invalid] }).tokens[0];
    assert.equal(asset.sources[0].rawAmount, null); assert.equal(asset.sources[0].eligibility.kind, "blocked");
  }
  for (const decimals of [NaN, -1, 256, 0.5]) {
    const invalid = structuredClone(input.items[0]); invalid.mint!.decimals = decimals;
    asset = model({ ...input, items: [invalid] }).tokens[0];
    assert.equal(asset.decimals, null); assert.equal(tokenSourceDisplay(asset, asset.sources[0]), "Unavailable");
  }
});

test("verified decimals through 255 support display while existing Send range stays 0–18", () => {
  for (const decimals of [0, 6, 18, 19, 255]) {
    const group = holding(); group.mint.decimals = decimals; group.accounts[0].state.amount = 1n;
    const input = snapshot(group), asset = model(input).tokens[0];
    assert.equal(asset.decimals, decimals);
    assert.equal(tokenSourceDisplay(asset, asset.sources[0]), decimals ? `0.${"0".repeat(decimals - 1)}1` : "1");
    assert.equal(asset.sources[0].eligibility.kind, decimals <= 18 ? "preflight-candidate" : "blocked");
    assert.equal(tokenSendSources(input.items[0], wallet, now).length, decimals <= 18 ? 1 : 0);
    group.accounts[0].state.amount = 0n;
    const zero = model(snapshot(group)).tokens[0]; assert.equal(tokenSourceDisplay(zero, zero.sources[0]), "0");
  }
});

test("frozen and failed sources expose safe block reasons without raw internal errors", () => {
  const input = snapshot(), frozen = structuredClone(input.items[0]); frozen.tokenAccounts[0].state!.isFrozen = true;
  assert.deepEqual(model({ ...input, items: [frozen] }).tokens[0].sources[0].eligibility, { kind: "blocked", reason: "frozen" });
  const failed = structuredClone(input.items[0]); failed.tokenAccounts[0].error = "rpc internal proxy secret-placeholder";
  const result = model({ ...input, items: [failed] });
  assert.equal(result.tokens[0].sources[0].rawAmount, null);
  assert.doesNotMatch(JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v), /proxy|secret-placeholder/);
});

test("INCLUDED or isNew discovery observations stay provisional and never grant Send eligibility", () => {
  const group = holding(); group.mintFinality = "provisional"; group.accounts[0].finality = "provisional";
  const asset = model(snapshot(group)).tokens[0];
  assert.equal(asset.observation.finality, "provisional"); assert.equal(asset.sources[0].observation.finality, "provisional");
  assert.equal(asset.sources[0].eligibility.kind, "blocked");
  assert.match(observationNotices(asset.observation, now).join(" "), /Provisional/);
});

test("observed timestamps and versions are retained only from matching evidence", () => {
  const asset = model().tokens[0];
  assert.equal(asset.observation.observedAt, now);
  assert.deepEqual(asset.observation.version, { slot: "100", seq: "2" });
  assert.deepEqual(asset.sources[0].observation.version, { slot: "100", seq: "3" });
  assert.equal(asset.observation.consensus, null); // No exact consensus supplied by discovery.
  const input = snapshot(); const mismatching = holding(); mismatching.mint.decimals = 9; mismatching.accounts[0].state.amount = 99n;
  const unknown = model({ ...input, holdings: [mismatching], liveHoldings: [mismatching] }).tokens[0];
  assert.equal(unknown.observation.observedAt, null); assert.equal(unknown.sources[0].observation.version, null);
});

test("cached metadata cannot manufacture live verification time or upgrade provisional finality", () => {
  const input = snapshot();
  const noLiveEvidence = model({ ...input, liveHoldings: [] }).tokens[0];
  assert.equal(noLiveEvidence.observation.observedAt, null);
  assert.equal(noLiveEvidence.sources[0].observation.version, null);
  const item = structuredClone(input.items[0]); item.discoveryAuthoritative = false; item.tokenAccounts[0].discoveryAuthoritative = false;
  const uncertain = model({ ...input, items: [item] }).tokens[0];
  assert.equal(uncertain.observation.finality, "provisional"); assert.equal(uncertain.sources[0].observation.finality, "provisional");
});

test("fresh, expired, future and cached timestamps preserve original verification time", () => {
  const input = snapshot();
  for (const time of [now, now + 60_001, now - 1]) {
    const sourceAccount = model(input, time).tokens[0].sources[0];
    assert.equal(sourceAccount.observation.observedAt, now);
    assert.equal(sourceAccount.freshness, time < now ? "unknown" : time > now ? "stale" : "fresh");
    assert.equal(sourceAccount.eligibility.kind, time === now ? "preflight-candidate" : "blocked");
  }
  const cached = model(snapshot(holding(), true), now + 5000).tokens[0];
  assert.equal(cached.sources[0].freshness, "stale"); assert.equal(cached.sources[0].observation.observedAt, now);
  assert.equal(cached.observation.source, "cache"); assert.equal(cached.sources[0].eligibility.kind, "blocked");
});

test("mixed cache/live sources keep their own provenance and never receive a fabricated aggregate", () => {
  const live = snapshot(), cached = snapshot(holding(), true);
  const item = { ...live.items[0], tokenAccounts: [...live.items[0].tokenAccounts,
    { ...cached.items[0].tokenAccounts[0], address: address(20) }] };
  const asset = model({ ...live, items: [item] }).tokens[0];
  assert.deepEqual(asset.sources.map((s) => s.observation.source), ["rpc", "cache"]);
  assert.deepEqual(asset.sources.map((s) => s.eligibility.kind), ["preflight-candidate", "blocked"]);
  assert.equal("balance" in asset || "spendableBalance" in asset, false);
});

test("created-source policy remains unchanged even without discovery timestamps/finality", () => {
  const input = snapshot(), group = holding();
  const created: TokenPortfolioItem = { walletAddress: wallet, mintAddress: mint, mint: group.mint,
    tokenAccounts: [{ address: source, state: group.accounts[0].state }] };
  const asset = model({ ...input, items: [created] }, now + 999_999).tokens[0];
  assert.equal(asset.sources[0].eligibility.kind, "preflight-candidate");
  assert.equal(asset.sources[0].freshness, "unknown"); assert.equal(asset.observation.finality, "unknown");
  assert.equal(asset.observation.observedAt, null);
  assert.deepEqual(tokenSendSources(created, wallet, now + 999_999), created.tokenAccounts);
  assert.equal(validateTransferPreflight({ activeWalletAddress: wallet, mintAddress: mint, mint: group.mint,
    sourceAddress: source, destinationAddress: address(20), source: group.accounts[0].state,
    destination: { owner: other, mint, amount: 0n, isFrozen: false }, amount: "1" }), 1_000_000n);
});

test("coverage retains cursor, failures and observation time without claiming complete holdings", () => {
  const input = snapshot();
  for (const state of ["partial", "exhausted", "unavailable"] as const) {
    const result = model({ ...input, discovery: { ...input.discovery!, state } });
    assert.equal(result.coverage.state, state); assert.equal(result.coverage.unresolvedCandidates, 2);
    assert.equal(result.coverage.continuation?.cursor, "next"); assert.equal(result.coverage.observedAt, now);
    assert.equal(result.coverage.completeWalletHoldings, false);
    assert.equal(result.tokens[0].coverage, result.coverage);
    assert.ok(coverageNotice(result.coverage).length > 30);
  }
  assert.match(coverageNotice(model({ ...input, discovery: { ...input.discovery!, state: "exhausted" } }).coverage), /not guaranteed/);
  assert.equal(model({ ...input, discovery: { ...input.discovery!, network: "alphanet:1" } }).coverage.state, "unavailable");
});

test("offline/checking preserves public observations but not current balance or send candidates", () => {
  for (const networkStatus of ["Offline", "Checking"] as const) {
    const result = buildWalletPortfolio({ scope, tokens: snapshot(), native: { scope, availability: "available", rawBalance: 0n,
      observation: unknownObservation() }, now, networkStatus });
    assert.equal(result.native.rawBalance, null); assert.equal(result.tokens[0].sources[0].rawAmount, 1_234_567n);
    assert.equal(result.tokens[0].sources[0].freshness, "stale");
    assert.deepEqual(result.tokens[0].sources[0].eligibility, { kind: "blocked", reason: "network-unavailable" });
  }
});

test("pure projection never touches secret getters, I/O, signing, timers or mutates source inputs", (t) => {
  const input = snapshot(); const before = structuredClone(input);
  for (const value of [input, input.scope, input.items[0], input.items[0].tokenAccounts[0]]) {
    for (const key of ["privateKey", "mnemonic", "sign", "send", "write", "refreshRecords"]) {
      Object.defineProperty(value, key, { get: () => { throw new Error("Forbidden access"); }, enumerable: true });
    }
  }
  t.mock.method(globalThis, "fetch", () => { throw new Error("No RPC allowed"); });
  t.mock.method(globalThis, "setTimeout", () => { throw new Error("No polling allowed"); });
  const result = model(input); assert.equal(result.tokens[0].sources[0].rawAmount, 1_234_567n);
  assert.doesNotMatch(JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v), /privateKey|mnemonic/);
  assert.equal(input.items[0].tokenAccounts[0].state!.amount, before.items[0].tokenAccounts[0].state!.amount);
  assert.equal(input.discovery!.continuation!.cursor, before.discovery!.continuation!.cursor);
});
