import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildTokenSidebarEntries } from "../components/port/token/PortTokenSidebar";
import {
  ALPHANET_RPC_DEGRADED_MESSAGE,
  ALPHANET_RPC_UNAVAILABLE_MESSAGE,
} from "../lib/thru/name-service/constants";
import {
  invokeTokenNetworkAction,
  safeTokenActionError,
  safeTokenReadError,
  tokenNetworkActionsDisabled,
  tokenNetworkReadAllowed,
  tokenNetworkWarning,
} from "../lib/token/network-state";

const TOKEN_STUDIO_SOURCE = readFileSync(
  join(process.cwd(), "components/TokenStudio.tsx"),
  "utf8",
);
const TOKEN_SIDEBAR_SOURCE = readFileSync(
  join(process.cwd(), "components/port/token/PortTokenSidebar.tsx"),
  "utf8",
);
const TOKEN_CREATE_SOURCE = readFileSync(
  join(process.cwd(), "components/token-studio/TokenCreateForm.tsx"),
  "utf8",
);
const TOKEN_SEND_SOURCE = readFileSync(
  join(process.cwd(), "components/token-studio/TokenSendForm.tsx"),
  "utf8",
);
const PORTFOLIO_HOOK_SOURCE = readFileSync(
  join(process.cwd(), "lib/token/portfolio-hook.ts"),
  "utf8",
);
const GLOBAL_STYLES = readFileSync(
  join(process.cwd(), "app/globals.css"),
  "utf8",
);

test("Tokens renders the centralized safe offline warning", () => {
  assert.equal(
    tokenNetworkWarning("Offline"),
    ALPHANET_RPC_UNAVAILABLE_MESSAGE,
  );
  assert.match(
    TOKEN_STUDIO_SOURCE,
    /name-network-message name-network-offline pc-token-network-message/,
  );
});

test("Tokens has only one page-level offline warning", () => {
  assert.equal(
    (
      TOKEN_STUDIO_SOURCE.match(
        /name-network-message name-network-offline pc-token-network-message/g,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(TOKEN_SEND_SOURCE, /Cannot transfer tokens while AlphaNet/);
});

test("raw token transport failures are mapped to the safe message", () => {
  const raw =
    "[unavailable] upstream connect error: connection refused at https://rpc.invalid";
  assert.equal(safeTokenReadError(new Error(raw)), ALPHANET_RPC_UNAVAILABLE_MESSAGE);
  assert.equal(
    safeTokenActionError(new Error(raw), "Token action failed."),
    ALPHANET_RPC_UNAVAILABLE_MESSAGE,
  );
  assert.doesNotMatch(PORTFOLIO_HOOK_SOURCE, /error\.message/);
});

test("Create New is disabled with neutral styling while offline", () => {
  assert.equal(tokenNetworkActionsDisabled("Offline"), true);
  assert.match(TOKEN_SIDEBAR_SOURCE, /disabled=\{createDisabled\}/);
  assert.match(
    GLOBAL_STYLES,
    /\.pc-token-studio-root \.token-network-action:disabled[\s\S]*?cursor: not-allowed;[\s\S]*?transform: none;/,
  );
});

test("disabled Create New performs no action", () => {
  let calls = 0;
  const invoked = invokeTokenNetworkAction(() => {
    calls += 1;
  }, "Offline");
  assert.equal(invoked, false);
  assert.equal(calls, 0);
});

test("token search remains usable while offline", () => {
  const searchSection = TOKEN_SIDEBAR_SOURCE.slice(
    TOKEN_SIDEBAR_SOURCE.indexOf('<div className="pc-token-search">'),
    TOKEN_SIDEBAR_SOURCE.indexOf('<div className="pc-token-list">'),
  );
  assert.match(searchSection, /value=\{search\}/);
  assert.match(searchSection, /onChange=\{\(e\) => setSearch\(e\.target\.value\)\}/);
  assert.doesNotMatch(searchSection, /disabled=/);
});

test("locally saved token entries remain visible while offline", () => {
  const entries = buildTokenSidebarEntries(
    [],
    [
      {
        mintAddress: "saved-mint",
        label: "Saved Token",
        walletAddress: "wallet",
        tokenAccountAddresses: ["saved-token-account"],
      },
    ],
  );
  assert.deepEqual(entries, [
    {
      mintAddress: "saved-mint",
      label: "Saved Token",
      secondaryLabel: undefined,
      tokenAccountAddresses: ["saved-token-account"],
      liveValidated: false,
    },
  ]);
  assert.match(
    TOKEN_SIDEBAR_SOURCE,
    /Live token state is unavailable\. No locally saved token references are available\./,
  );
});

test("transfer and token-creation network actions are disabled offline", () => {
  assert.match(
    TOKEN_SEND_SOURCE,
    /const healthDisabled = isHealthOffline \|\| isHealthChecking;/,
  );
  assert.match(TOKEN_SEND_SOURCE, /disabled=\{busy \|\| !transferAllowed\}/);
  assert.match(TOKEN_CREATE_SOURCE, /if \(!account \|\| networkActionsDisabled\) return;/);
  assert.match(
    TOKEN_CREATE_SOURCE,
    /disabled=\{busy \|\| networkActionsDisabled\}/,
  );
  assert.doesNotMatch(TOKEN_CREATE_SOURCE, /Recover created token|Recover token/);
});

test("offline portfolio reads are skipped without deleting saved records", () => {
  assert.equal(tokenNetworkReadAllowed("Offline"), false);
  assert.match(
    PORTFOLIO_HOOK_SOURCE,
    /if \(!walletAddress \|\| !networkReadAllowed\) \{[\s\S]*?requestTrackerRef\.current\.invalidate\(\);[\s\S]*?return;/,
  );
  const offlineRefreshGuard =
    PORTFOLIO_HOOK_SOURCE.match(
      /if \(!walletAddress \|\| !networkReadAllowed\) \{[\s\S]*?return;\s*\}/,
    )?.[0] ?? "";
  assert.doesNotMatch(offlineRefreshGuard, /saveKnownTokens/);
});

test("degraded mode warns but continues to permit safe reads", () => {
  assert.equal(tokenNetworkWarning("Degraded"), ALPHANET_RPC_DEGRADED_MESSAGE);
  assert.equal(tokenNetworkReadAllowed("Degraded"), true);
  assert.equal(tokenNetworkActionsDisabled("Degraded"), false);
});

test("online mode removes the warning and restores normal action eligibility", () => {
  let calls = 0;
  assert.equal(tokenNetworkWarning("Online"), null);
  assert.equal(tokenNetworkReadAllowed("Online"), true);
  assert.equal(tokenNetworkActionsDisabled("Online"), false);
  assert.equal(
    invokeTokenNetworkAction(() => {
      calls += 1;
    }, "Online"),
    true,
  );
  assert.equal(calls, 1);
  assert.match(
    TOKEN_SEND_SOURCE,
    /account && selectedTokenMint && transferSource && transferDestination && transferAmount\.trim\(\)/,
  );
});
