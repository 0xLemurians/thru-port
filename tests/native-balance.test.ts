import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Account, ConsensusStatus, Pubkey } from "@thru/sdk";
import { NativeBalanceReader, nativeObservationFromAccount, visibleNativeObservation } from "../lib/portfolio/native-observation";
import { buildWalletPortfolio, unknownObservation, type PortfolioScope } from "../lib/portfolio/asset-model";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./helpers/css-modules";
import {
  formatNativeThruAmount,
  NATIVE_THRU_BALANCE_UNIT,
} from "../lib/wallet/native-balance";

test("native balance formatting preserves exact uint64 precision", () => {
  assert.equal(formatNativeThruAmount(0n), "0");
  assert.equal(formatNativeThruAmount(1n), "1");
  assert.equal(formatNativeThruAmount(10_000n), "10000");
  assert.equal(
    formatNativeThruAmount(18_446_744_073_709_551_615n),
    "18446744073709551615",
  );
  assert.equal(NATIVE_THRU_BALANCE_UNIT, "native units");
  assert.throws(() => formatNativeThruAmount(-1n), /negative/);
});

test("Dashboard and wallet popover share the exact native-unit formatter", async () => {
  assert.match(readFileSync(path.join(process.cwd(), "components/port/PortDashboard.tsx"), "utf8"), /formatNativeThruAmount\(balance\)/);
  for (const relative of [
    "components/command/CommandDashboard.tsx",
    "components/port/PortWalletPopover.tsx",
  ]) {
    const source = readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.match(source, /NativeAssetSummary asset=\{model.native\}/);
    assert.doesNotMatch(source, /Number\(balance\)|formatRawAmount\(balance/);
  }
  const { NativeAssetSummary } = await import("../components/command/PortfolioAssets");
  for (const value of [null, 0n, 1n, 18_446_744_073_709_551_615n]) {
    const model = buildWalletPortfolio({ scope: displayScope, tokens: null, networkStatus: "Online", now: 1000,
      native: value === null ? null : { scope: displayScope, availability: "available", rawBalance: value, observation: unknownObservation() } });
    const html = renderToStaticMarkup(React.createElement(NativeAssetSummary, { asset: model.native }));
    assert.ok(html.includes(value === null ? "Unavailable" : `${formatNativeThruAmount(value)} native units`));
  }
});

const publicAddress = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
const displayScope: PortfolioScope = { networkId: "betanet", chainId: 2, walletAddress: publicAddress(70) };
function balanceAccount(balance = 0n, address = displayScope.walletAddress, consensusStatus = ConsensusStatus.INCLUDED): Account {
  return new Account({ address: Pubkey.from(address), meta: { version: 1, owner: Pubkey.from(publicAddress(71)),
    nonce: 1n, seq: 2n, balance, dataSize: 0, flags: { isProgram: false, isPrivileged: false, isNew: false,
      isDeleted: false, isEphemeral: false, isCompressed: false, isUncompressable: false } }, consensusStatus,
    versionContext: { slot: 100n, seq: 2n } });
}

test("UI native point read distinguishes missing account/meta from an actual on-chain zero", async () => {
  const observed = nativeObservationFromAccount(displayScope, balanceAccount(), 1000);
  assert.equal(observed.availability, "available"); assert.equal(observed.rawBalance, 0n);
  assert.equal(observed.observation.finality, "provisional"); assert.equal(observed.observation.consensus, "INCLUDED");
  assert.deepEqual(observed.observation.version, { slot: "100", seq: "2" });
  const missingMeta = nativeObservationFromAccount(displayScope, new Account({ address: Pubkey.from(displayScope.walletAddress) }), 1000);
  assert.equal(missingMeta.rawBalance, null);
  const reader = new NativeBalanceReader(() => ({ get: async () => { throw Object.assign(new Error("internal not_found"), { code: 5 }); } }));
  assert.equal((await reader.read(displayScope, "Online", () => true))?.rawBalance, null);
});

test("native observation validates public identity, flags and uint64 without claiming EOA readiness", () => {
  assert.equal(nativeObservationFromAccount(displayScope, balanceAccount(1n, publicAddress(72)), 1000).rawBalance, null);
  for (const flag of ["isDeleted", "isEphemeral", "isCompressed"] as const) {
    const original = balanceAccount();
    const account = new Account({ ...original, meta: { ...original.meta!, flags: { ...original.meta!.flags, [flag]: true } } });
    assert.equal(nativeObservationFromAccount(displayScope, account, 1000).rawBalance, null);
  }
  for (const raw of [-1n, 1n << 64n]) assert.equal(nativeObservationFromAccount(displayScope, balanceAccount(raw), 1000).rawBalance, null);
  const original = balanceAccount(0n, displayScope.walletAddress, ConsensusStatus.FINALIZED);
  const provisional = new Account({ ...original, meta: { ...original.meta!, flags: { ...original.meta!.flags, isNew: true } } });
  assert.equal(nativeObservationFromAccount(displayScope, provisional, 1000).observation.finality, "provisional");
  assert.equal(nativeObservationFromAccount(displayScope, balanceAccount(1n, displayScope.walletAddress, ConsensusStatus.UNSPECIFIED), 1000).rawBalance, null);
});

test("native reader preserves exact large BigInt and known finality/version fields", async () => {
  for (const status of [ConsensusStatus.CLUSTER_EXECUTED, ConsensusStatus.FINALIZED]) {
    const reader = new NativeBalanceReader(() => ({ get: async () => balanceAccount((1n << 64n) - 1n, displayScope.walletAddress, status) }), () => 5000);
    const result = await reader.read(displayScope, "Degraded", () => true);
    assert.equal(result?.rawBalance, 18_446_744_073_709_551_615n);
    assert.equal(result?.observation.finality, "authoritative"); assert.equal(result?.observation.observedAt, 5000);
  }
});

test("missing native version context is not replaced by an invented slot or timestamp", () => {
  const account = new Account({ ...balanceAccount(), versionContext: undefined });
  const result = nativeObservationFromAccount(displayScope, account, Number.NaN);
  assert.equal(result.observation.version?.slot, null); assert.equal(result.observation.observedAt, null);
});

test("UI native reader makes no request while offline/checking or scoped to another network", async () => {
  let calls = 0;
  const reader = new NativeBalanceReader(() => { calls++; return { get: async () => balanceAccount() }; });
  for (const status of ["Offline", "Checking"] as const) assert.equal((await reader.read(displayScope, status, () => true))?.rawBalance, null);
  assert.equal((await reader.read({ ...displayScope, networkId: "alphanet", chainId: 1 }, "Online", () => true))?.rawBalance, null);
  assert.equal(calls, 0);
});

test("new refresh wins over delayed prior balance; cancellation is passed to the read transport", async () => {
  let resolveOld!: (account: Account) => void;
  let calls = 0;
  const signals: AbortSignal[] = [];
  const reader = new NativeBalanceReader((signal, timeoutMs) => {
    signals.push(signal); assert.equal(timeoutMs, 4000);
    return { get: async () => { calls++; return calls === 1 ? new Promise<Account>((resolve) => { resolveOld = resolve; }) : balanceAccount(2n); } };
  });
  const old = reader.read(displayScope, "Online", () => true);
  const latest = await reader.read(displayScope, "Online", () => true);
  resolveOld(balanceAccount(999n));
  assert.equal(await old, null); assert.equal(latest?.rawBalance, 2n); assert.equal(signals[0].aborted, true); assert.equal(calls, 2);
});

test("wallet/network switches and unmount suppress late results and old-wallet presentation", async () => {
  let resolve!: (account: Account) => void;
  let current = true;
  const reader = new NativeBalanceReader(() => ({ get: () => new Promise<Account>((done) => { resolve = done; }) }));
  const pending = reader.read(displayScope, "Online", () => current);
  current = false; resolve(balanceAccount(100n)); assert.equal(await pending, null);
  current = true;
  const unmounted = reader.read(displayScope, "Online", () => current);
  reader.cancel(); resolve(balanceAccount(200n)); assert.equal(await unmounted, null);
  const observed = nativeObservationFromAccount(displayScope, balanceAccount(), 1000);
  assert.equal(visibleNativeObservation({ ...displayScope, walletAddress: publicAddress(73) }, observed, "Online"), null);
  assert.equal(visibleNativeObservation({ ...displayScope, networkId: "alphanet", chainId: 1 }, observed, "Online"), null);
  assert.equal(visibleNativeObservation(null, observed, "Online"), null);
  assert.equal(visibleNativeObservation(displayScope, observed, "Offline"), null);
  assert.equal(visibleNativeObservation(displayScope, observed, "Online")?.rawBalance, 0n);
});

test("a stale refresh callback cannot cancel the current wallet's in-flight read", async () => {
  let resolve!: (account: Account) => void;
  let signal: AbortSignal | undefined;
  const reader = new NativeBalanceReader((activeSignal) => {
    signal = activeSignal;
    return { get: () => new Promise<Account>((done) => { resolve = done; }) };
  });
  const current = reader.read(displayScope, "Online", () => true);
  assert.equal(await reader.read({ ...displayScope, walletAddress: publicAddress(72) }, "Online", () => false), null);
  assert.equal(signal?.aborted, false);
  resolve(balanceAccount(4n)); assert.equal((await current)?.rawBalance, 4n);
});

test("a late callback after unmount cannot start another native read", async () => {
  let mounted = true, calls = 0;
  const reader = new NativeBalanceReader(() => ({ get: async () => { calls++; return balanceAccount(); } }));
  assert.equal((await reader.read(displayScope, "Online", () => mounted))?.rawBalance, 0n);
  mounted = false; reader.cancel();
  assert.equal(await reader.read(displayScope, "Online", () => mounted), null);
  assert.equal(calls, 1);
});

test("bounded native display read times out once without retry or lingering polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const reader = new NativeBalanceReader(() => ({ get: () => { calls++; return new Promise<Account>(() => {}); } }));
  const pending = reader.read(displayScope, "Online", () => true);
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result?.availability, "unavailable"); assert.equal(result?.rawBalance, null);
  t.mock.timers.tick(100_000); assert.equal(calls, 1);
});

test("native transport failures remain generic unavailable data; model never reads secrets or write methods", async () => {
  let reads = 0;
  const account = balanceAccount();
  Object.defineProperty(account, "privateKey", { get: () => { throw new Error("Forbidden secret access"); } });
  const adapter = { get: async () => { reads++; return account; }, sign: () => { throw new Error("Forbidden sign"); },
    send: () => { throw new Error("Forbidden send"); } };
  const reader = new NativeBalanceReader(() => adapter);
  assert.equal((await reader.read(displayScope, "Online", () => true))?.rawBalance, 0n); assert.equal(reads, 1);
  const failed = new NativeBalanceReader(() => ({ get: async () => { throw new Error("grpc internal URL credential-placeholder"); } }));
  const result = await failed.read(displayScope, "Online", () => true);
  assert.doesNotMatch(JSON.stringify(result), /grpc|URL|credential-placeholder/);
});
