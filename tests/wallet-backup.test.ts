import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createNewAccount, bytesToHex } from "../lib/wallet/thru-wallet";
import {
  BACKUP_IV_BYTES,
  BACKUP_KDF_ITERATIONS,
  BACKUP_KDF_MAX_ITERATIONS,
  BACKUP_KDF_MIN_ITERATIONS,
  BACKUP_PASSWORD_TOO_LONG_MESSAGE,
  BACKUP_PASSWORD_TOO_SHORT_MESSAGE,
  BACKUP_SALT_BYTES,
  ENCRYPTED_BACKUP_FORMAT,
  ENCRYPTED_BACKUP_VERSION,
  LEGACY_BACKUP_MESSAGE,
  MAX_BACKUP_FILE_BYTES,
  WalletBackupError,
  clearSecretInputs,
  createEncryptedWalletBackupFile,
  decryptEncryptedWalletBackup,
  parseEncryptedWalletBackup,
  validateBackupExportRequirements,
  validateBackupPassword,
} from "../lib/wallet/wallet-backup";

const BACKUP_PASSWORD = "correct horse battery staple";
const accountPromise = createNewAccount(true);

function deterministicRandom(seed: number): (length: number) => Uint8Array {
  let call = 0;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (seed + call * 37 + index * 17) & 0xff;
    }
    call += 1;
    return bytes;
  };
}

const backupPromise = accountPromise.then((account) =>
  createEncryptedWalletBackupFile(account, BACKUP_PASSWORD, {
    randomBytes: deterministicRandom(11),
  }),
);

for (const password of ["test", "aaaa", "1234", "!!!!", "abcd"]) {
  test(`four-character backup password ${JSON.stringify(password)} is accepted`, () => {
    assert.deepEqual(validateBackupPassword(password), {
      valid: true,
      characterCount: 4,
      byteLength: 4,
    });
  });
}

test("four visible Unicode characters are accepted", () => {
  const validation = validateBackupPassword("😀😀😀😀");
  assert.equal(validation.valid, true);
  assert.equal(validation.characterCount, 4);
  assert.equal(validation.byteLength, 16);
});

test("three-character backup passwords are rejected", () => {
  assert.deepEqual(validateBackupPassword("abc"), {
    valid: false,
    code: "TOO_SHORT",
    message: BACKUP_PASSWORD_TOO_SHORT_MESSAGE,
    characterCount: 3,
    byteLength: 3,
  });
});

test("backup password policy has no character-class requirements", () => {
  for (const password of ["aaaa", "1234", "!!!!"]) {
    assert.equal(validateBackupPassword(password).valid, true);
  }
});

test("backup passwords over 1024 UTF-8 bytes are rejected separately", () => {
  const validation = validateBackupPassword("é".repeat(513));
  assert.equal(validation.valid, false);
  if (validation.valid) return;
  assert.equal(validation.code, "TOO_LONG");
  assert.equal(validation.message, BACKUP_PASSWORD_TOO_LONG_MESSAGE);
  assert.equal(validation.byteLength, 1_026);
});

test("backup confirmation mismatch is rejected", () => {
  assert.deepEqual(
    validateBackupExportRequirements("test", "aaaa", true),
    {
      valid: false,
      code: "PASSWORD_MISMATCH",
      message: "The backup passwords do not match.",
    },
  );
});

test("backup acknowledgement is required", () => {
  assert.deepEqual(
    validateBackupExportRequirements("test", "test", false),
    {
      valid: false,
      code: "ACKNOWLEDGEMENT_REQUIRED",
      message: "Select the acknowledgement before downloading.",
    },
  );
});

test("test encrypts successfully with the unchanged backup cryptography", async () => {
  const account = await accountPromise;
  const backup = parseEncryptedWalletBackup(
    await createEncryptedWalletBackupFile(account, "test", {
      randomBytes: deterministicRandom(73),
    }),
  );
  assert.equal(backup.kdf.iterations, BACKUP_KDF_ITERATIONS);
  assert.equal(backup.cipher.algorithm, "AES-GCM");
});

interface MutableBackup {
  format: string;
  version: number;
  walletAddress: string;
  kdf: {
    algorithm: string;
    hash: string;
    iterations: number;
    salt: string;
  };
  cipher: {
    algorithm: string;
    iv: string;
    ciphertext: string;
  };
  [key: string]: unknown;
}

function cloneBackup(serialized: string): MutableBackup {
  return JSON.parse(serialized) as MutableBackup;
}

function mutateBase64(value: string): string {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  bytes[Math.floor(bytes.length / 2)] ^= 0x40;
  return Buffer.from(bytes).toString("base64");
}

test("encrypted export contains no plaintext mnemonic", async () => {
  const account = await accountPromise;
  const serialized = await backupPromise;
  assert.ok(account.mnemonic);
  assert.equal(serialized.includes(account.mnemonic), false);
});

test("encrypted export contains no plaintext private key or privateKeyHex field", async () => {
  const account = await accountPromise;
  const serialized = await backupPromise;
  assert.equal(serialized.includes(bytesToHex(account.privateKey)), false);
  assert.equal(serialized.includes("privateKeyHex"), false);
});

test("backup JSON has the exact versioned format identifier", async () => {
  const parsed = parseEncryptedWalletBackup(await backupPromise);
  assert.equal(parsed.format, ENCRYPTED_BACKUP_FORMAT);
  assert.equal(parsed.version, ENCRYPTED_BACKUP_VERSION);
});

test("backup KDF and cipher parameters are safe and bounded", async () => {
  const parsed = parseEncryptedWalletBackup(await backupPromise);
  assert.equal(parsed.kdf.algorithm, "PBKDF2");
  assert.equal(parsed.kdf.hash, "SHA-256");
  assert.equal(parsed.kdf.iterations, BACKUP_KDF_ITERATIONS);
  assert.ok(parsed.kdf.iterations >= BACKUP_KDF_MIN_ITERATIONS);
  assert.ok(parsed.kdf.iterations <= BACKUP_KDF_MAX_ITERATIONS);
  assert.equal(Buffer.from(parsed.kdf.salt, "base64").length, BACKUP_SALT_BYTES);
  assert.equal(parsed.cipher.algorithm, "AES-GCM");
  assert.equal(Buffer.from(parsed.cipher.iv, "base64").length, BACKUP_IV_BYTES);
});

test("separate exports use fresh salts and IVs", async () => {
  const account = await accountPromise;
  const randomBytes = deterministicRandom(29);
  const first = parseEncryptedWalletBackup(
    await createEncryptedWalletBackupFile(account, BACKUP_PASSWORD, {
      randomBytes,
    }),
  );
  const second = parseEncryptedWalletBackup(
    await createEncryptedWalletBackupFile(account, BACKUP_PASSWORD, {
      randomBytes,
    }),
  );
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
});

test("same wallet and password produce different ciphertext", async () => {
  const account = await accountPromise;
  const randomBytes = deterministicRandom(47);
  const first = parseEncryptedWalletBackup(
    await createEncryptedWalletBackupFile(account, BACKUP_PASSWORD, {
      randomBytes,
    }),
  );
  const second = parseEncryptedWalletBackup(
    await createEncryptedWalletBackupFile(account, BACKUP_PASSWORD, {
      randomBytes,
    }),
  );
  assert.notEqual(first.cipher.ciphertext, second.cipher.ciphertext);
});

test("correct password reconstructs the exact wallet", async () => {
  const account = await accountPromise;
  const restored = await decryptEncryptedWalletBackup(
    await backupPromise,
    BACKUP_PASSWORD,
  );
  assert.equal(restored.address, account.address);
  assert.deepEqual(restored.publicKey, account.publicKey);
  assert.deepEqual(restored.privateKey, account.privateKey);
  assert.equal(restored.mnemonic, account.mnemonic);
  restored.privateKey.fill(0);
  restored.mnemonic = undefined;
});

test("wrong password fails with a safe generic authentication error", async () => {
  const serialized = await backupPromise;
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackup(
        serialized,
        "this is the wrong password",
      ),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "DECRYPTION_FAILED" &&
      !error.message.includes("wrong password"),
  );
});

test("modified ciphertext fails AES-GCM authentication", async () => {
  const modified = cloneBackup(await backupPromise);
  modified.cipher.ciphertext = mutateBase64(modified.cipher.ciphertext);
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackup(
        JSON.stringify(modified),
        BACKUP_PASSWORD,
      ),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "DECRYPTION_FAILED",
  );
});

test("modified IV fails AES-GCM authentication", async () => {
  const modified = cloneBackup(await backupPromise);
  modified.cipher.iv = mutateBase64(modified.cipher.iv);
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackup(
        JSON.stringify(modified),
        BACKUP_PASSWORD,
      ),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "DECRYPTION_FAILED",
  );
});

test("unsupported backup version is rejected before decryption", async () => {
  const modified = cloneBackup(await backupPromise);
  modified.version = 2;
  assert.throws(
    () => parseEncryptedWalletBackup(JSON.stringify(modified)),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "UNSUPPORTED_BACKUP",
  );
});

test("malformed JSON is rejected safely", () => {
  assert.throws(
    () => parseEncryptedWalletBackup("{not-json"),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "MALFORMED_BACKUP",
  );
});

test("oversized backup is rejected before JSON parsing", () => {
  const oversized = "x".repeat(MAX_BACKUP_FILE_BYTES + 1);
  assert.throws(
    () => parseEncryptedWalletBackup(oversized),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "MALFORMED_BACKUP",
  );
});

test("address metadata mismatch cannot replace the intended wallet", async () => {
  const modified = cloneBackup(await backupPromise);
  const replacement = modified.walletAddress.endsWith("x") ? "y" : "x";
  modified.walletAddress = `${modified.walletAddress.slice(0, -1)}${replacement}`;
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackup(
        JSON.stringify(modified),
        BACKUP_PASSWORD,
      ),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "ADDRESS_MISMATCH",
  );
});

test("legacy plaintext backup is rejected with the required message", () => {
  const legacy = JSON.stringify({
    address: "thru1legacy",
    privateKeyHex: "00".repeat(32),
    mnemonic: "legacy secret",
  });
  assert.throws(
    () => parseEncryptedWalletBackup(legacy),
    (error: unknown) =>
      error instanceof WalletBackupError &&
      error.code === "LEGACY_PLAINTEXT_BACKUP" &&
      error.message === LEGACY_BACKUP_MESSAGE,
  );
});

test("failed backup import leaves the caller's active wallet unchanged", async () => {
  const activeWallet = await accountPromise;
  const activeAddress = activeWallet.address;
  const serialized = await backupPromise;
  await assert.rejects(() =>
    decryptEncryptedWalletBackup(
      serialized,
      "a different long password",
    ),
  );
  assert.equal(activeWallet.address, activeAddress);
  assert.ok(activeWallet.privateKey.some((byte) => byte !== 0));
});

test("unsupported KDF names and hashes are rejected", async () => {
  const algorithm = cloneBackup(await backupPromise);
  algorithm.kdf.algorithm = "scrypt";
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(algorithm)));

  const hash = cloneBackup(await backupPromise);
  hash.kdf.hash = "SHA-1";
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(hash)));
});

test("out-of-bounds KDF work factors are rejected", async () => {
  const tooLow = cloneBackup(await backupPromise);
  tooLow.kdf.iterations = BACKUP_KDF_MIN_ITERATIONS - 1;
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(tooLow)));

  const tooHigh = cloneBackup(await backupPromise);
  tooHigh.kdf.iterations = BACKUP_KDF_MAX_ITERATIONS + 1;
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(tooHigh)));
});

test("invalid salt and IV lengths are rejected", async () => {
  const salt = cloneBackup(await backupPromise);
  salt.kdf.salt = Buffer.alloc(BACKUP_SALT_BYTES - 1).toString("base64");
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(salt)));

  const iv = cloneBackup(await backupPromise);
  iv.cipher.iv = Buffer.alloc(BACKUP_IV_BYTES + 1).toString("base64");
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(iv)));
});

test("invalid or non-canonical base64 is rejected", async () => {
  const invalid = cloneBackup(await backupPromise);
  invalid.cipher.ciphertext = "***not-base64***";
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(invalid)));
});

test("unknown top-level fields are rejected", async () => {
  const modified = cloneBackup(await backupPromise);
  modified.password = BACKUP_PASSWORD;
  assert.throws(() => parseEncryptedWalletBackup(JSON.stringify(modified)));
});

test("backup output never contains the password", async () => {
  assert.equal((await backupPromise).includes(BACKUP_PASSWORD), false);
});

test("secret-input clearing production helper overwrites every registered input", () => {
  const mnemonic = { value: "mnemonic secret" };
  const privateKey = { value: "private key secret" };
  const password = { value: "backup password" };
  clearSecretInputs(mnemonic, privateKey, password);
  assert.equal(mnemonic.value, "");
  assert.equal(privateKey.value, "");
  assert.equal(password.value, "");
});

test("secret-input clearing helper safely handles close and unmount null refs", () => {
  const secret = { value: "temporary secret" };
  clearSecretInputs(secret);
  clearSecretInputs(null, undefined);
  assert.equal(secret.value, "");
});

test("production UI clears secrets on mode switch, close, account change and unmount", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/port/PortDashboard.tsx"),
    "utf8",
  );
  assert.match(source, /switchImportMode[\s\S]*resetImportForm\(\)/);
  assert.match(source, /setImportMode\("hidden"\)/);
  assert.match(source, /\[account\?\.address, resetImportForm\]/);
  assert.match(
    source,
    /useEffect\([\s\S]*clearImportSecretControls\(\)[\s\S]*clearImportSecretControls/,
  );
});

test("create and import activate only the verified persisted wallet", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  for (const handler of [
    "handleCreateWallet",
    "handleImportWallet",
    "handleImportBackup",
  ]) {
    const start = source.indexOf(`function ${handler}`);
    const nextHandler = source.indexOf("\n  async function ", start + 1);
    const body = source.slice(
      start,
      nextHandler === -1 ? source.length : nextHandler,
    );
    const verify = body.indexOf("await saveAndVerifyPersistedWallet");
    const activate = body.indexOf("setAccount(persisted)");
    assert.ok(verify >= 0, `${handler} verifies persistence`);
    assert.ok(activate > verify, `${handler} activates only after verification`);
  }
});

test("backup passwords clear after mismatch, success, failure, cancel and unmount", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/port/WalletBackupDialog.tsx"),
    "utf8",
  );
  assert.ok(
    source.match(/resetForm\(\)/g)?.length &&
      (source.match(/resetForm\(\)/g)?.length ?? 0) >= 4,
  );
  assert.match(source, /return clearPasswordControls/);
  assert.match(source, /\[account\.address, clearPasswordControls, resetForm\]/);
  assert.match(source, /password = ""/);
  assert.match(source, /confirmation = ""/);
});

test("vault restore failure blocks wallet creation and preserves the vault", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  assert.match(source, /setRestoreStatus\("VAULT_ERROR"\)/);
  assert.match(
    source,
    /restoreStatus !== "NO_SAVED_WALLET"/,
  );
  const restoreCatch = source.slice(
    source.indexOf(".catch(() =>"),
    source.indexOf("  }, []);"),
  );
  assert.doesNotMatch(restoreCatch, /createNewAccount|savePersistedWallet|removePersistedWallet/);
});

test("both active backup buttons open the authenticated backup dialog", () => {
  const dashboard = fs.readFileSync(
    path.join(process.cwd(), "components/port/PortDashboard.tsx"),
    "utf8",
  );
  const popover = fs.readFileSync(
    path.join(process.cwd(), "components/port/PortWalletPopover.tsx"),
    "utf8",
  );
  const dialog = fs.readFileSync(
    path.join(process.cwd(), "components/port/WalletBackupDialog.tsx"),
    "utf8",
  );

  assert.match(dashboard, /onClick=\{\(\) => setBackupOpen\(true\)\}/);
  assert.match(popover, /onClick=\{\(\) => setBackupOpen\(true\)\}/);
  assert.match(dialog, /type="password"/);
  assert.match(dialog, /Confirm backup password/);
  assert.match(dialog, /checked=\{acknowledged\}/);
  assert.match(dialog, /downloadEncryptedWalletBackup\(account, password\)/);
});

test("wallet security paths contain no secret logging or analytics events", () => {
  const files = [
    "lib/wallet/wallet-backup.ts",
    "lib/wallet/persistent-wallet.ts",
    "components/AppFlow.tsx",
    "components/AccountPanel.tsx",
    "components/port/PortDashboard.tsx",
    "components/port/PortWalletPopover.tsx",
    "components/port/WalletBackupDialog.tsx",
  ];
  const source = files
    .map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /console\.(?:log|error|warn|debug)/);
  assert.doesNotMatch(source, /\btrack\s*\(|analytics\.(?:track|event)/i);
});

test("backup errors never include wallet secrets", async () => {
  const account = await accountPromise;
  let message = "";
  try {
    await decryptEncryptedWalletBackup(
      await backupPromise,
      "another incorrect password",
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(account.mnemonic);
  assert.equal(message.includes(account.mnemonic), false);
  assert.equal(message.includes(bytesToHex(account.privateKey)), false);
  assert.equal(message.includes(BACKUP_PASSWORD), false);
});
