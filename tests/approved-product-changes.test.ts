import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const appFlow = source("components/AppFlow.tsx");
const dashboard = source("components/port/PortDashboard.tsx");
const backupScreen = source(
  "components/port/OneTimePrivateKeyBackup.tsx",
);
const backupDialog = source("components/port/WalletBackupDialog.tsx");
const tokenCreate = source(
  "components/token-studio/TokenCreateForm.tsx",
);
const identity = source("components/NameStudio.tsx");

test("Import Wallet exposes exactly Private Key and Encrypted Backup", () => {
  assert.equal(dashboard.match(/className=\{`pc-tab/g)?.length, 2);
  assert.match(dashboard, />\s*Private Key\s*<\/button>/);
  assert.match(dashboard, />\s*Encrypted Backup\s*<\/button>/);
  assert.doesNotMatch(dashboard, /Recovery Phrase|recovery phrase|mnemonic/i);
  assert.match(dashboard, /onClick=\{\(\) => switchImportMode\("hex"\)\}/);
});

test("removed Recovery Phrase import is not keyboard-accessible", () => {
  assert.doesNotMatch(dashboard, /switchImportMode\("mnemonic"\)/);
  assert.doesNotMatch(dashboard, /aria-label=["'{][^"'{}]*Recovery Phrase/i);
  assert.doesNotMatch(appFlow, /accountFromMnemonic|kind === "mnemonic"/);
});

test("manual Recover Created Token UI is absent while normal creation remains", () => {
  assert.doesNotMatch(tokenCreate, /Recover created token|Recover token/);
  assert.doesNotMatch(tokenCreate, /token-recovery-panel|handleRecover/);
  assert.match(tokenCreate, />\s*\{busy \? "Creating token…".*"Create token"\}\s*</s);
});

test("pending-token safety persistence and automatic workflow hooks remain", () => {
  assert.match(tokenCreate, /onPendingSetupAvailable: handlePendingSetupAvailable/);
  assert.match(tokenCreate, /onSetupComplete: handleSetupComplete/);
  assert.match(tokenCreate, /loadPendingSetups\(window\.localStorage\)/);
  assert.match(tokenCreate, /savePendingSetups\(window\.localStorage/);
});

test("Identity is an AlphaNet notice with no registration request controls", () => {
  assert.match(identity, /not currently available on AlphaNet/);
  assert.match(identity, /announce on X when registration becomes available/);
  assert.doesNotMatch(identity, /Check Availability|Confirm registration|Register\s*</);
  assert.doesNotMatch(
    identity,
    /lookupThruName|purchaseThruName|NameRegisterForm|NameLookupForm/,
  );
});

test("pending wallet setup is persisted at creation and restored on startup", () => {
  const createStart = appFlow.indexOf("async function handleCreateWallet");
  const importStart = appFlow.indexOf("async function handleImportWallet");
  const createBody = appFlow.slice(createStart, importStart);
  assert.match(
    createBody,
    /saveAndVerifyPersistedWallet\(candidate,\s*\{\s*setupPending: true/,
  );
  assert.match(appFlow, /isPersistedWalletSetupPending\(restored\.address\)/);
  assert.match(appFlow, /setShowOneTimePrivateKeyBackup\(setupPending\)/);
  assert.doesNotMatch(
    appFlow.slice(
      appFlow.indexOf("restorePersistedWallet()"),
      createStart,
    ),
    /createNewAccount/,
  );
});

test("pending wallet setup clears only from the final Continue handler", () => {
  assert.equal(
    appFlow.match(/completePersistedWalletSetup\(/g)?.length,
    1,
  );
  const completion = appFlow.slice(
    appFlow.indexOf("async function handleCompleteWalletSetup"),
    appFlow.indexOf("// Phase 2 disconnect"),
  );
  assert.match(completion, /await completePersistedWalletSetup\(account\.address\)/);
  assert.match(completion, /setShowOneTimePrivateKeyBackup\(false\)/);
  assert.match(
    backupScreen,
    /onClick=\{\(\) => void continueToWorkspace\(\)\}/,
  );
});

test("created-wallet screen retains reveal, copy, backup, and safe completion", () => {
  assert.match(backupScreen, /Reveal private key/);
  assert.match(backupScreen, /Copy private key/);
  assert.match(backupScreen, /<WalletBackupDialog/);
  assert.match(backupScreen, /Create JSON backup/);
  assert.match(backupScreen, /Unable to finish wallet setup securely/);
});

test("backup download requires the plaintext-key warning acknowledgment", () => {
  assert.match(backupDialog, /contains your private key in plain text/);
  assert.match(backupDialog, /does not protect the visible plaintext privateKey field/);
  assert.match(backupDialog, /checked=\{acknowledged\}/);
  assert.match(
    backupDialog,
    /disabled=\{\s*pending \|\|[\s\S]*!acknowledged\s*\}/,
  );
});
