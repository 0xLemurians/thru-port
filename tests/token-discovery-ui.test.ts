import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pubkey } from "@thru/sdk";
import type { TokenPortfolioHook } from "../lib/token/portfolio-hook";
import type { TokenPortfolioItem } from "../lib/token/thru-token";
import { NATIVE_SEND_ENABLED } from "../lib/wallet/native-transfer-controller";
import type { ThruAccount } from "../lib/wallet/thru-wallet";

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true,
      source: 'export default new Proxy({}, { get: (_target, name) => String(name) });' };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);

const address = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
const wallet = address(20), other = address(21), mintAddress = address(22), custom = address(23);
function item(): TokenPortfolioItem {
  return { walletAddress: wallet, mintAddress,
    mint: { creator: other, mintAuthority: other, freezeAuthority: null, hasFreezeAuthority: false, decimals: 6, supply: 7n, ticker: "RCV" },
    tokenAccounts: [{ address: custom, state: { owner: wallet, mint: mintAddress, amount: 7n, isFrozen: false } }] };
}
function hook(): TokenPortfolioHook {
  return { records: [], portfolio: [], storageReady: true, refreshing: false, portfolioError: null, persistenceWarning: null,
    refreshRecords: async () => {}, persistAndRefresh: () => {}, addKnownToken: () => {}, removeKnownToken: () => {}, clearExternalAssets: () => {} };
}
test("real discovery status component makes coverage explicit and disables network controls offline", async () => {
  const { default: Status } = await import("../components/token-studio/TokenDiscoveryStatus");
  const state = hook(); state.discovery = { walletAddress: wallet, network: "betanet:2", holdings: [], state: "partial",
    continuation: { version: 1, walletAddress: wallet, network: "betanet:2", program: address(24), cursor: "page2",
      pendingAddresses: [custom], seenCursors: ["page2"], inventoryExhausted: false },
    pagesInspected: 2, accountsInspected: 64, candidateReadFailures: 1, verifiedAt: 1000, diagnostics: [] };
  state.continueDiscovery = () => {};
  const online = renderToStaticMarkup(React.createElement(Status, { portfolio: state, status: "Online" }));
  assert.match(online, /Partial scan/); assert.match(online, /64 candidates/); assert.match(online, /1 unresolved reads/);
  assert.match(online, /Continue discovery/); assert.match(online, /not a guarantee/); assert.doesNotMatch(online, /All tokens found/);
  const offline = renderToStaticMarkup(React.createElement(Status, { portfolio: state, status: "Offline" }));
  assert.match(offline, /RPC unavailable/); assert.equal((offline.match(/disabled=""/g) ?? []).length, 2);
  assert.match(offline, /role="status" aria-live="polite"/);
});
test("exhausted state says available RPC inventory, not complete wallet-wide coverage", async () => {
  const { default: Status } = await import("../components/token-studio/TokenDiscoveryStatus");
  const state = hook(); state.discovery = { walletAddress: wallet, network: "betanet:2", holdings: [], state: "exhausted", continuation: null,
    pagesInspected: 1, accountsInspected: 1, candidateReadFailures: 0, verifiedAt: 1000, diagnostics: [] };
  const html = renderToStaticMarkup(React.createElement(Status, { portfolio: state, status: "Online" }));
  assert.match(html, /Scan complete for available RPC inventory/); assert.doesNotMatch(html, /Continue discovery|all tokens found/i);
});
test("real sidebar separates received-only holdings from created records and preserves cached/offline entries", async () => {
  const { default: Sidebar } = await import("../components/port/token/PortTokenSidebar");
  const received = item(); received.discoveryRead = "cached";
  const createdMint = address(25);
  const html = renderToStaticMarkup(React.createElement(Sidebar, { portfolio: [received],
    savedRecords: [{ mintAddress: createdMint, walletAddress: wallet, label: "Created locally", tokenAccountAddresses: [] }],
    selectedToken: mintAddress, walletAddress: wallet, onSelectToken: () => {}, onCreateNew: () => {}, loading: false, error: null, networkStatus: "Offline" }));
  const holdings = html.slice(html.indexOf('aria-label="My Holdings"'), html.indexOf('aria-label="Created / Controlled Tokens"'));
  assert.match(holdings, /RCV/); assert.match(holdings, /Live state unavailable/);
  assert.doesNotMatch(holdings, /Created \/ controlled by this wallet/);
  const controlled = html.slice(html.indexOf('aria-label="Created / Controlled Tokens"'));
  assert.match(controlled, /Created locally/);
  assert.doesNotMatch(html.slice(html.indexOf('placeholder="Search tokens'), html.indexOf('pc-token-list')), /disabled/);
  assert.match(html, /disabled=""[^>]*>Create New/);
});
test("actual source picker labels individual custom sources, not an aggregate spendable balance", async () => {
  const { default: Picker } = await import("../components/token-studio/TokenSourcePicker");
  const asset = item(); asset.tokenAccounts.push({ address: address(26), state: { owner: wallet, mint: mintAddress, amount: 9n, isFrozen: false } });
  const html = renderToStaticMarkup(React.createElement(Picker, { item: asset, wallet, value: custom, disabled: false, onChange: () => {} }));
  assert.match(html, /Balance source · one token account/); assert.equal((html.match(/<option/g) ?? []).length, 2);
  assert.match(html, /class="inputSelect mono"/); // The existing Command Center dark/light select, not legacy globals.
  assert.match(html, /aria-label="Balance source · one token account"/);
  assert.match(html, /0.000007/); assert.match(html, /0.000009/); assert.doesNotMatch(html, /0.000016/);
  const disabled = renderToStaticMarkup(React.createElement(Picker, { item: asset, wallet, value: custom, disabled: true, onChange: () => {} }));
  assert.match(disabled, /<select[^>]*disabled/); assert.match(disabled, /<label[^>]*for=/);
});
test("actual wallet popover reserves the narrow left-anchor gutter and renders without reading secrets", async () => {
  const { default: Popover } = await import("../components/port/PortWalletPopover");
  let secretReads = 0;
  const publicOnly: ThruAccount = { address: wallet, publicKey: Pubkey.from(wallet).toBytes(),
    get privateKey(): never { secretReads++; throw new Error("Test forbids secret access"); } };
  const base = { id: "public-test-popover", account: publicOnly, balance: 10n,
    health: { status: "Online" as const, lastChecked: null, checkNow: () => {} } };
  const left = renderToStaticMarkup(React.createElement(Popover, { ...base, align: "left" }));
  const right = renderToStaticMarkup(React.createElement(Popover, { ...base, align: "right" }));
  assert.match(left, /max-width:calc\(100vw - 80px\)/);
  assert.match(right, /max-width:calc\(100vw - 32px\)/);
  assert.match(left, /role="dialog" aria-label="Wallet actions"/);
  assert.equal(secretReads, 0);
});
test("discovery integration leaves Native Send disabled and uses only read APIs with no secret access", () => {
  assert.equal(NATIVE_SEND_ENABLED, false);
  for (const path of ["lib/token/discovery.ts", "lib/token/discovery-cache.ts", "components/token-studio/TokenDiscoveryStatus.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\.sign\(|toWire\(|sendAndTrack\(|transactions\.send\(|privateKey|mnemonic|console\./, path);
  }
  const source = readFileSync("lib/token/discovery.ts", "utf8");
  assert.match(source, /reader\.list\(/); assert.match(source, /reader\.get\(/);
  assert.doesNotMatch(source, /listForAccount|proofs\.generate|accounts\.create|setInterval/);
});
