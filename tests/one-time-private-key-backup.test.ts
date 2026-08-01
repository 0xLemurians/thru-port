import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
  PRIVATE_KEY_AUTO_HIDE_MS,
  PRIVATE_KEY_COPY_ERROR_MESSAGE,
  PRIVATE_KEY_COPY_STATUS_MS,
  PRIVATE_KEY_MASK,
  copyPrivateKeyToClipboard,
  reduceOneTimePrivateKeyBackupState,
  schedulePrivateKeyAutoHide,
  shouldShowOneTimePrivateKeyBackup,
} from "../lib/wallet/one-time-private-key-backup";

const APP_FLOW_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "components/AppFlow.tsx"),
  "utf8",
);
const SCREEN_SOURCE = fs.readFileSync(
  path.join(
    process.cwd(),
    "components/port/OneTimePrivateKeyBackup.tsx",
  ),
  "utf8",
);
const STATE_SOURCE = fs.readFileSync(
  path.join(
    process.cwd(),
    "lib/wallet/one-time-private-key-backup.ts",
  ),
  "utf8",
);

test("newly created wallet enters the one-time private-key screen after persistence", () => {
  assert.equal(shouldShowOneTimePrivateKeyBackup("created"), true);
  const createStart = APP_FLOW_SOURCE.indexOf(
    "async function handleCreateWallet",
  );
  const importStart = APP_FLOW_SOURCE.indexOf(
    "async function handleImportWallet",
  );
  const createBody = APP_FLOW_SOURCE.slice(createStart, importStart);
  const persisted = createBody.indexOf(
    "await saveAndVerifyPersistedWallet(candidate,",
  );
  const gate = createBody.indexOf(
    'shouldShowOneTimePrivateKeyBackup("created")',
  );
  assert.ok(persisted >= 0);
  assert.ok(gate > persisted);
  assert.match(createBody, /setupPending: true/);
  assert.match(APP_FLOW_SOURCE, /<OneTimePrivateKeyBackup/);
});

test("new wallet creation does not generate or persist an unused mnemonic", () => {
  const createBody = APP_FLOW_SOURCE.slice(
    APP_FLOW_SOURCE.indexOf("async function handleCreateWallet"),
    APP_FLOW_SOURCE.indexOf("async function handleImportWallet"),
  );
  assert.match(createBody, /createNewAccount\(false\)/);
  assert.doesNotMatch(createBody, /createNewAccount\(true\)/);
  assert.ok(
    createBody.indexOf("saveAndVerifyPersistedWallet") <
      createBody.indexOf("setAccount(persisted)"),
  );
});

test("only created and persisted pending wallets enter the one-time screen", () => {
  for (const source of [
    "restored",
    "private-key-import",
    "encrypted-backup-import",
  ] as const) {
    assert.equal(shouldShowOneTimePrivateKeyBackup(source), false);
  }

  assert.match(APP_FLOW_SOURCE, /isPersistedWalletSetupPending\(restored\.address\)/);
  assert.match(APP_FLOW_SOURCE, /setShowOneTimePrivateKeyBackup\(setupPending\)/);
  assert.match(APP_FLOW_SOURCE, /shouldShowOneTimePrivateKeyBackup\("private-key-import"\)/);
  assert.match(
    APP_FLOW_SOURCE,
    /shouldShowOneTimePrivateKeyBackup\("encrypted-backup-import"\)/,
  );
});

test("private key is hidden and masked initially", () => {
  assert.equal(
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE.revealed,
    false,
  );
  assert.equal(PRIVATE_KEY_MASK.length, 64);
  assert.equal(PRIVATE_KEY_MASK.includes("0"), false);
});

test("Reveal displays the key only after an explicit action and Hide masks again", () => {
  const shown = reduceOneTimePrivateKeyBackupState(
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
    { type: "show" },
  );
  assert.equal(shown.revealed, true);
  const hidden = reduceOneTimePrivateKeyBackupState(shown, { type: "hide" });
  assert.equal(hidden.revealed, false);
  assert.match(SCREEN_SOURCE, /onClick=\{state\.revealed \? hidePrivateKey : showPrivateKey\}/);
});

test("hidden state renders the open-eye Reveal control", () => {
  assert.match(
    SCREEN_SOURCE,
    /data-private-key-icon="eye-open"[\s\S]*aria-hidden="true"/,
  );
  assert.match(
    SCREEN_SOURCE,
    /\{state\.revealed \? "Hide" : "Reveal"\}/,
  );
  assert.match(
    SCREEN_SOURCE,
    /state\.revealed[\s\S]*"Hide private key"[\s\S]*"Reveal private key"/,
  );
});

test("visible state renders the eye-off Hide control", () => {
  assert.match(
    SCREEN_SOURCE,
    /data-private-key-icon="eye-off"[\s\S]*aria-hidden="true"/,
  );
  assert.match(
    SCREEN_SOURCE,
    /state\.revealed \? <EyeOffIcon \/> : <EyeIcon \/>/,
  );
});

test("reveal control is an accessible native keyboard button", () => {
  assert.match(
    SCREEN_SOURCE,
    /<button[\s\S]*type="button"[\s\S]*aria-label=[\s\S]*aria-pressed=\{state\.revealed\}[\s\S]*onClick=\{state\.revealed \? hidePrivateKey : showPrivateKey\}/,
  );
  assert.doesNotMatch(SCREEN_SOURCE, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(SCREEN_SOURCE, /<svg[\s\S]*https?:\/\//);
});

test("auto-hide is scheduled for exactly 30 seconds", () => {
  let scheduledDelay = -1;
  let scheduled = false;
  let scheduledCallback = () => {};
  let state = reduceOneTimePrivateKeyBackupState(
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
    { type: "show" },
  );

  schedulePrivateKeyAutoHide(
    (callback, delayMs) => {
      scheduled = true;
      scheduledCallback = callback;
      scheduledDelay = delayMs;
      return "timer";
    },
    () => {
      state = reduceOneTimePrivateKeyBackupState(state, { type: "hide" });
    },
  );

  assert.equal(scheduledDelay, PRIVATE_KEY_AUTO_HIDE_MS);
  assert.equal(scheduledDelay, 30_000);
  assert.equal(scheduled, true);
  scheduledCallback();
  assert.equal(state.revealed, false);
});

test("Continue is blocked before acknowledgement and dismisses after acknowledgement", () => {
  const blocked = reduceOneTimePrivateKeyBackupState(
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
    { type: "continue" },
  );
  assert.equal(blocked.dismissed, false);

  const acknowledged = reduceOneTimePrivateKeyBackupState(blocked, {
    type: "acknowledge",
    value: true,
  });
  const dismissed = reduceOneTimePrivateKeyBackupState(acknowledged, {
    type: "continue",
  });
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.revealed, false);
  assert.equal(dismissed.acknowledged, false);
  assert.match(
    SCREEN_SOURCE,
    /disabled=\{!state\.acknowledged \|\| continuePending\}/,
  );
});

test("dismissed screen state cannot reveal or reopen", () => {
  const acknowledged = reduceOneTimePrivateKeyBackupState(
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
    { type: "acknowledge", value: true },
  );
  const dismissed = reduceOneTimePrivateKeyBackupState(acknowledged, {
    type: "continue",
  });
  assert.equal(
    reduceOneTimePrivateKeyBackupState(dismissed, { type: "show" }),
    dismissed,
  );
  assert.equal(
    APP_FLOW_SOURCE.match(
      /shouldShowOneTimePrivateKeyBackup\("created"\)/g,
    )?.length,
    1,
  );
});

test("reload restores the completion screen only from the persisted marker", () => {
  const restoreStart = APP_FLOW_SOURCE.indexOf("restorePersistedWallet()");
  const createStart = APP_FLOW_SOURCE.indexOf("async function handleCreateWallet");
  const restoreBody = APP_FLOW_SOURCE.slice(restoreStart, createStart);
  assert.match(restoreBody, /isPersistedWalletSetupPending/);
  assert.match(restoreBody, /setShowOneTimePrivateKeyBackup\(setupPending\)/);
  assert.doesNotMatch(restoreBody, /createNewAccount/);
});

test("copy requires an explicit call and never runs automatically", async () => {
  const privateKey = Uint8Array.from(
    { length: 32 },
    (_, index) => (index * 7 + 3) & 0xff,
  );
  let writes = 0;
  let writtenLength = 0;
  const writeText = async (value: string) => {
    writes += 1;
    writtenLength = value.length;
  };

  assert.equal(writes, 0);
  assert.equal(
    await copyPrivateKeyToClipboard(privateKey, writeText),
    "copied",
  );
  assert.equal(writes, 1);
  assert.equal(writtenLength, 64);
  assert.match(SCREEN_SOURCE, /onClick=\{\(\) => void copyPrivateKey\(\)\}/);
});

test("clipboard failure returns only the safe message", async () => {
  const privateKey = new Uint8Array(32);
  const result = await copyPrivateKeyToClipboard(privateKey, async () => {
    throw new Error("browser permission internals");
  });
  assert.equal(result, "error");
  assert.equal(
    PRIVATE_KEY_COPY_ERROR_MESSAGE,
    "Unable to copy the private key. Copy it manually.",
  );
  assert.match(SCREEN_SOURCE, /\{PRIVATE_KEY_COPY_ERROR_MESSAGE\}/);
  assert.doesNotMatch(SCREEN_SOURCE, /permission internals|caught\.message|error\.message/);
});

test("copy status clears after a short bounded delay", () => {
  assert.equal(PRIVATE_KEY_COPY_STATUS_MS, 2_000);
  assert.match(SCREEN_SOURCE, /clear-copy-status/);
  assert.match(SCREEN_SOURCE, /clearCopyStatusTimer/);
});

test("visibility loss, Continue, and unmount all hide or clear the display", () => {
  assert.match(SCREEN_SOURCE, /document\.visibilityState !== "visible"/);
  assert.match(SCREEN_SOURCE, /hidePrivateKey\(\)/);
  assert.match(SCREEN_SOURCE, /displayRef\.current\.textContent = ""/);
  assert.match(SCREEN_SOURCE, /clearAutoHideTimer\(\)/);
  assert.match(SCREEN_SOURCE, /clearCopyStatusTimer\(\)/);
  assert.match(
    SCREEN_SOURCE,
    /document\.removeEventListener\("visibilitychange"/,
  );
});

test("the one-time screen is client-only and server output starts masked", () => {
  assert.equal(SCREEN_SOURCE.startsWith('"use client";'), true);
  assert.match(
    SCREEN_SOURCE,
    /state\.revealed[\s\S]*bytesToHex\(account\.privateKey\)[\s\S]*PRIVATE_KEY_MASK/,
  );
  assert.match(
    APP_FLOW_SOURCE,
    /account && showOneTimePrivateKeyBackup/,
  );
});

test("one-time private-key paths contain no logging, analytics, URLs, or downloads", () => {
  const source = `${SCREEN_SOURCE}\n${STATE_SOURCE}`;
  assert.doesNotMatch(source, /console\.(?:log|error|warn|debug)/);
  assert.doesNotMatch(source, /\btrack\s*\(|analytics\.(?:track|event)/i);
  assert.doesNotMatch(source, /window\.location|document\.title|href=/);
  assert.doesNotMatch(
    source,
    /download\s*=|createObjectURL|new Blob|FileSaver/,
  );
});

test("one-time screen has no mnemonic or alternate-wallet path", () => {
  assert.doesNotMatch(SCREEN_SOURCE, /mnemonic|recovery phrase|owner address/i);
  assert.doesNotMatch(SCREEN_SOURCE, /wallet popover|alternate wallet/i);
});
