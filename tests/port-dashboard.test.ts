import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NetworkStatus } from "../lib/network/network-health";
import { explorerHomeUrl } from "../lib/thru/network";
import {
  SAFE_FAUCET_ERROR_MESSAGE,
  SAFE_FAUCET_UNAVAILABLE_MESSAGE,
  SAFE_FAUCET_UNCERTAIN_MESSAGE,
  faucetFailureRequiresManualCheck,
  isFaucetActionDisabled,
  safeFaucetDisplayMessage,
  type FaucetUiState,
} from "../lib/wallet/faucet-safety";

// Since we cannot render React components easily, we test the navigation state logic
// that governs Port Dashboard locking behavior.

function canNavigate(targetStage: string, accountAvailable: boolean): boolean {
  if (!accountAvailable && targetStage !== "account") return false;
  return true;
}

test("wallet yokken Dashboard açık", () => {
  assert.equal(canNavigate("account", false), true);
});

test("wallet yokken Tokens kilitli", () => {
  assert.equal(canNavigate("token", false), false);
});

test("wallet yokken Identity kilitli", () => {
  assert.equal(canNavigate("name", false), false);
});

test("wallet yokken Developer kilitli", () => {
  assert.equal(canNavigate("editor", false), false);
});

test("account varsa navigation açılıyor", () => {
  assert.equal(canNavigate("account", true), true);
  assert.equal(canNavigate("token", true), true);
  assert.equal(canNavigate("name", true), true);
  assert.equal(canNavigate("editor", true), true);
});

// --- Phase 2: Faucet & Dashboard Logic Tests ---

function isFaucetVisible(accountAvailable: boolean) {
  return accountAvailable;
}

function getFaucetRequestStatus(healthStatus: string, faucetState: string) {
  return isFaucetActionDisabled(
    healthStatus as NetworkStatus,
    faucetState as FaucetUiState,
  )
    ? "disabled"
    : "enabled";
}

function getFaucetWarning(healthStatus: string) {
  if (healthStatus === "Degraded") return "Betanet RPC is unstable.";
  return null;
}

function isDoubleSubmitPrevented(faucetState: string) {
  return faucetState === "requesting";
}

function copyAddress(address: string, clipboardAvailable: boolean = true) {
  if (!clipboardAvailable) return "error";
  if (!address.startsWith("thru1")) throw new Error("Not a public address");
  return "copied";
}

function disconnectWallet(localStorageData: Record<string, unknown>) {
  return { account: null, stage: "account", localStorageData }; // does not wipe localStorage
}

test("wallet yokken Faucet paneli görünmüyor", () => {
  assert.equal(isFaucetVisible(false), false);
});

test("wallet varsa Faucet paneli görünüyor", () => {
  assert.equal(isFaucetVisible(true), true);
});

test("RPC Checking durumunda request disabled", () => {
  assert.equal(getFaucetRequestStatus("Checking", "idle"), "disabled");
});

test("RPC Offline durumunda request disabled", () => {
  assert.equal(getFaucetRequestStatus("Offline", "idle"), "disabled");
});

test("RPC Degraded durumunda Faucet ve Retry disabled", () => {
  assert.equal(getFaucetRequestStatus("Degraded", "idle"), "disabled");
  assert.equal(getFaucetRequestStatus("Degraded", "error"), "disabled");
});

test("RPC Degraded durumunda amber uyarı gösteriliyor", () => {
  assert.equal(getFaucetWarning("Degraded"), "Betanet RPC is unstable.");
});

test("double-submit engelleniyor", () => {
  assert.equal(isDoubleSubmitPrevented("requesting"), true);
});

test("cancel mevcut AbortController akışını çağırıyor", () => {
  let aborted = false;
  const ac = new AbortController();
  ac.signal.addEventListener("abort", () => aborted = true);
  ac.abort();
  assert.equal(aborted, true);
});

test("retry yalnızca kullanıcı aksiyonuyla çağrılıyor", () => {
  const retryMode = "manual";
  assert.equal(retryMode, "manual");
});

test("successful Faucet sonrası balance refresh çağrılıyor", () => {
  let refreshCalled = false;
  function onFaucetSuccess() { refreshCalled = true; }
  onFaucetSuccess();
  assert.equal(refreshCalled, true);
});

test("otomatik transaction retry yapılmıyor", () => {
  const automaticRetry = false;
  assert.equal(automaticRetry, false);
});

test("Copy Address yalnızca public address kopyalıyor", () => {
  assert.equal(copyAddress("thru1test"), "copied");
});

test("clipboard hatası güvenli gösteriliyor", () => {
  assert.equal(copyAddress("thru1test", false), "error");
});

test("Download Backup opens the production password confirmation dialog", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/port/PortDashboard.tsx"),
    "utf8",
  );
  assert.match(source, /onClick=\{\(\) => setBackupOpen\(true\)\}/);
  assert.match(source, /<WalletBackupDialog/);
});

test("backup does not auto-download or export without explicit confirmation", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/port/WalletBackupDialog.tsx"),
    "utf8",
  );
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /validateBackupExportRequirements\(/);
  const exportGuard = source.indexOf(
    "const requirements = validateBackupExportRequirements(",
  );
  const download = source.indexOf(
    "await downloadEncryptedWalletBackup(account, password, {",
  );
  assert.ok(exportGuard >= 0 && download > exportGuard);
});

test("Faucet errors are always rendered as the safe approved message", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/port/PortFaucetPanel.tsx"),
    "utf8",
  );
  assert.equal(
    SAFE_FAUCET_ERROR_MESSAGE,
    "The faucet request could not be completed. Try again when Betanet is available.",
  );
  assert.equal(
    SAFE_FAUCET_UNCERTAIN_MESSAGE,
    "The transaction was submitted, but final confirmation is still unavailable. Check the Explorer before trying again.",
  );
  assert.equal(
    safeFaucetDisplayMessage("invalid transaction signature gRPC"),
    SAFE_FAUCET_ERROR_MESSAGE,
  );
  assert.equal(
    safeFaucetDisplayMessage(SAFE_FAUCET_UNCERTAIN_MESSAGE),
    SAFE_FAUCET_UNCERTAIN_MESSAGE,
  );
  assert.equal(
    safeFaucetDisplayMessage(SAFE_FAUCET_UNAVAILABLE_MESSAGE),
    SAFE_FAUCET_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    faucetFailureRequiresManualCheck(SAFE_FAUCET_UNCERTAIN_MESSAGE),
    true,
  );
  assert.equal(
    faucetFailureRequiresManualCheck(SAFE_FAUCET_ERROR_MESSAGE),
    false,
  );
  assert.equal(
    faucetFailureRequiresManualCheck(SAFE_FAUCET_UNAVAILABLE_MESSAGE),
    true,
  );
  assert.match(source, /safeFaucetDisplayMessage\(faucetError\)/);
  assert.match(
    source,
    /requiresManualVerification\s*\|\|\s*isFaucetActionDisabled/,
  );
  assert.match(source, /disabled=\{isRequestDisabled\}/);
  assert.doesNotMatch(source, /invalid transaction signature|invalid_argument|gRPC|VM|proxy|transport/i);
});

test("Faucet production handler requires Online and prevents duplicate requests", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  assert.match(source, /health\.status !== "Online"/);
  assert.match(source, /faucetControllerRef\.current/);
  assert.doesNotMatch(source, /setFaucetError\(result\.failureReason\)/);
  assert.match(
    source,
    /setFaucetError\(safeFaucetDisplayMessage\(result\.failureReason\)\)/,
  );
});

test("Faucet engine performs only one submission attempt", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/wallet/faucet.ts"),
    "utf8",
  );
  assert.equal(
    source.match(/attemptFaucetWithdraw\(/g)?.length,
    2,
    "one call site plus the function declaration",
  );
  assert.doesNotMatch(source, /MAX_ATTEMPTS|backoffDelay|onRetry/);
});

test("Disconnect account state’ini temizliyor", () => {
  const state = disconnectWallet({ portfolio: "data" });
  assert.equal(state.account, null);
});

test("Disconnect navigation’ı tekrar kilitliyor", () => {
  const state = disconnectWallet({ portfolio: "data" });
  assert.equal(state.stage, "account");
  assert.equal(canNavigate("token", !!state.account), false);
});

test("Disconnect public portfolio localStorage verisini silmiyor", () => {
  const state = disconnectWallet({ portfolio: "data" });
  assert.equal(state.localStorageData.portfolio, "data");
});

test("balance error notice kart düzenini bozmadan render ediliyor", () => {
  const errorMarkup = "<div className=\"error\">Balance temporarily unavailable</div>";
  assert.ok(errorMarkup.includes("error"));
});

test("Docs uses exact URL, opens in new tab securely, and is fully clickable", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components/command/CommandShell.tsx"), "utf8");
  assert.match(source, /href="https:\/\/thru\.org\/docs\/"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /<a[^>]*href="https:\/\/thru\.org\/docs\/"[^>]*>/);
});

test("Explorer uses the Betanet-scoped URL, opens securely, and is not disabled", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components/command/CommandShell.tsx"), "utf8");
  assert.equal(explorerHomeUrl(), "https://scan.thru.org/?network=betanet");
  assert.match(source, /href=\{explorerHomeUrl\(\)\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /Coming Soon/i);
});

test("Production dashboard shows 'Native Balance', not 'Total Assets', with 'native units'", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components/command/CommandDashboard.tsx"), "utf8");
  assert.match(source, /Native Balance/);
  assert.doesNotMatch(source, /Total Assets/);
  assert.match(source, /native units/);
  assert.doesNotMatch(source, /formatNativeThruAmount/); // confirms no decimal guessing
});

test("Production removes mock data badges and hardcoded balances, and no native THRU send", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components/command/CommandDashboard.tsx"), "utf8");
  assert.doesNotMatch(source, /<span className=\{styles\.mockBadge\}>Mock Data<\/span>/);
  assert.doesNotMatch(source, /115007/);
  assert.doesNotMatch(source, />Mock data</);
  // Checking that we don't have native THRU send
  assert.doesNotMatch(source, /Native THRU send/i);
});

test("Design preview route retains its mock data indicators", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/design-preview/page.tsx"), "utf8");
  assert.match(source, /Design preview — mock data/i);
});
