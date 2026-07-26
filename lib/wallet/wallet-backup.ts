import {
  type ThruAccount,
  accountFromMnemonic,
  accountFromPrivateKey,
  assertAccountIdentity,
  bytesToHex,
  hexToBytes,
} from "./thru-wallet";

export const ENCRYPTED_BACKUP_FORMAT = "thru-port-encrypted-wallet";
export const LEGACY_ENCRYPTED_BACKUP_VERSION = 1;
export const ENCRYPTED_BACKUP_VERSION = 2;
export const BACKUP_KDF_ITERATIONS = 310_000;
export const BACKUP_KDF_MIN_ITERATIONS = 100_000;
export const BACKUP_KDF_MAX_ITERATIONS = 1_000_000;
export const BACKUP_SALT_BYTES = 16;
export const BACKUP_IV_BYTES = 12;
export const MAX_BACKUP_FILE_BYTES = 64 * 1024;
export const MIN_BACKUP_PASSWORD_CHARACTERS = 4;
export const MAX_BACKUP_PASSWORD_BYTES = 1_024;
export const BACKUP_PASSWORD_TOO_SHORT_MESSAGE =
  "Use at least 4 characters. Any characters are allowed.";
export const BACKUP_PASSWORD_TOO_LONG_MESSAGE =
  "Password is too long. Use no more than 1024 UTF-8 bytes.";
export const BACKUP_PASSWORD_MISMATCH_MESSAGE =
  "The backup passwords do not match.";
export const BACKUP_ACKNOWLEDGEMENT_MESSAGE =
  "Select the acknowledgement before downloading.";
export const LEGACY_BACKUP_MESSAGE =
  "This legacy plaintext backup is not supported for security reasons.";

const MIN_CIPHERTEXT_BYTES = 17;
const MAX_CIPHERTEXT_BYTES = 32 * 1024;

export type BackupPasswordValidationCode = "TOO_SHORT" | "TOO_LONG";

export type BackupPasswordValidation =
  | {
      valid: true;
      characterCount: number;
      byteLength: number;
    }
  | {
      valid: false;
      code: BackupPasswordValidationCode;
      message: string;
      characterCount: number;
      byteLength: number;
    };

export type BackupExportValidation =
  | { valid: true }
  | {
      valid: false;
      code:
        | BackupPasswordValidationCode
        | "PASSWORD_MISMATCH"
        | "ACKNOWLEDGEMENT_REQUIRED";
      message: string;
    };

export type WalletBackupErrorCode =
  | "INVALID_PASSWORD"
  | "MALFORMED_BACKUP"
  | "UNSUPPORTED_BACKUP"
  | "LEGACY_PLAINTEXT_BACKUP"
  | "DECRYPTION_FAILED"
  | "ADDRESS_MISMATCH"
  | "WALLET_INVALID";

export class WalletBackupError extends Error {
  constructor(
    public readonly code: WalletBackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletBackupError";
  }
}

export interface EncryptedWalletBackup {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: typeof ENCRYPTED_BACKUP_VERSION;
  address: string;
  walletAddress: string;
  privateKey: string;
  createdAt: string;
  kdf: {
    algorithm: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    algorithm: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
}

interface LegacyEncryptedWalletBackup {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: typeof LEGACY_ENCRYPTED_BACKUP_VERSION;
  walletAddress: string;
  kdf: EncryptedWalletBackup["kdf"];
  cipher: EncryptedWalletBackup["cipher"];
}

type ParsedEncryptedWalletBackup =
  | EncryptedWalletBackup
  | LegacyEncryptedWalletBackup;

interface DecryptedWalletPayload {
  version: 1;
  address: string;
  privateKeyHex: string;
  mnemonic: string | null;
}

export interface BackupCryptoOptions {
  cryptoObj?: Crypto | null;
  randomBytes?: (length: number) => Uint8Array;
}

export interface SecretInputControl {
  value: string;
}

export function clearSecretInputs(
  ...controls: Array<SecretInputControl | null | undefined>
): void {
  for (const control of controls) {
    if (control) control.value = "";
  }
}

function getCrypto(cryptoOverride?: Crypto | null): Crypto {
  const cryptoObj =
    cryptoOverride !== undefined ? cryptoOverride : globalThis.crypto;
  if (!cryptoObj?.subtle || typeof cryptoObj.getRandomValues !== "function") {
    throw new WalletBackupError(
      "UNSUPPORTED_BACKUP",
      "Encrypted wallet backups are not supported in this browser.",
    );
  }
  return cryptoObj;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function makeRandomBytes(
  length: number,
  cryptoObj: Crypto,
  randomBytes?: (length: number) => Uint8Array,
): Uint8Array {
  const bytes = randomBytes
    ? new Uint8Array(randomBytes(length))
    : cryptoObj.getRandomValues(new Uint8Array(length));
  if (bytes.length !== length) {
    bytes.fill(0);
    throw new WalletBackupError(
      "UNSUPPORTED_BACKUP",
      "Encrypted wallet backups are not supported in this browser.",
    );
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function decodeBase64(
  value: unknown,
  expectedLength?: number,
  minLength?: number,
  maxLength?: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw malformedBackup();
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw malformedBackup();
  }

  if (
    encodeBase64(bytes) !== value ||
    (expectedLength !== undefined && bytes.length !== expectedLength) ||
    (minLength !== undefined && bytes.length < minLength) ||
    (maxLength !== undefined && bytes.length > maxLength)
  ) {
    bytes.fill(0);
    throw malformedBackup();
  }
  return bytes;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedBackup(): WalletBackupError {
  return new WalletBackupError(
    "MALFORMED_BACKUP",
    "This backup file is invalid or corrupted.",
  );
}

export function countVisibleUnicodeCharacters(value: string): number {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
  ).length;
}

export function validateBackupPassword(
  password: string,
): BackupPasswordValidation {
  const characterCount = countVisibleUnicodeCharacters(password);
  const encoded = new TextEncoder().encode(password);
  const byteLength = encoded.length;
  encoded.fill(0);

  if (characterCount < MIN_BACKUP_PASSWORD_CHARACTERS) {
    return {
      valid: false,
      code: "TOO_SHORT",
      message: BACKUP_PASSWORD_TOO_SHORT_MESSAGE,
      characterCount,
      byteLength,
    };
  }
  if (byteLength > MAX_BACKUP_PASSWORD_BYTES) {
    return {
      valid: false,
      code: "TOO_LONG",
      message: BACKUP_PASSWORD_TOO_LONG_MESSAGE,
      characterCount,
      byteLength,
    };
  }
  return { valid: true, characterCount, byteLength };
}

export function validateBackupExportRequirements(
  password: string,
  confirmation: string,
  acknowledged: boolean,
): BackupExportValidation {
  const passwordValidation = validateBackupPassword(password);
  if (!passwordValidation.valid) {
    return {
      valid: false,
      code: passwordValidation.code,
      message: passwordValidation.message,
    };
  }
  if (password !== confirmation) {
    return {
      valid: false,
      code: "PASSWORD_MISMATCH",
      message: BACKUP_PASSWORD_MISMATCH_MESSAGE,
    };
  }
  if (!acknowledged) {
    return {
      valid: false,
      code: "ACKNOWLEDGEMENT_REQUIRED",
      message: BACKUP_ACKNOWLEDGEMENT_MESSAGE,
    };
  }
  return { valid: true };
}

function validatePassword(password: string): Uint8Array {
  const validation = validateBackupPassword(password);
  if (!validation.valid) {
    throw new WalletBackupError(
      "INVALID_PASSWORD",
      validation.message,
    );
  }
  return new TextEncoder().encode(password);
}

async function deriveBackupKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usages: KeyUsage[],
  cryptoObj: Crypto,
): Promise<CryptoKey> {
  const passwordBytes = validatePassword(password);
  const passwordBuffer = copyToArrayBuffer(passwordBytes);
  const saltBuffer = copyToArrayBuffer(salt);
  try {
    const keyMaterial = await cryptoObj.subtle.importKey(
      "raw",
      passwordBuffer,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return await cryptoObj.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: saltBuffer,
        iterations,
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  } finally {
    passwordBytes.fill(0);
    new Uint8Array(passwordBuffer).fill(0);
    new Uint8Array(saltBuffer).fill(0);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function createEncryptedWalletBackup(
  account: ThruAccount,
  password: string,
  options: BackupCryptoOptions = {},
): Promise<EncryptedWalletBackup> {
  const cryptoObj = getCrypto(options.cryptoObj);
  await assertAccountIdentity(account).catch(() => {
    throw new WalletBackupError(
      "WALLET_INVALID",
      "The wallet backup could not be created because the wallet data is inconsistent.",
    );
  });

  const salt = makeRandomBytes(
    BACKUP_SALT_BYTES,
    cryptoObj,
    options.randomBytes,
  );
  const iv = makeRandomBytes(BACKUP_IV_BYTES, cryptoObj, options.randomBytes);
  let encodedPayload: Uint8Array | null = null;
  try {
    const key = await deriveBackupKey(
      password,
      salt,
      BACKUP_KDF_ITERATIONS,
      ["encrypt"],
      cryptoObj,
    );
    const payload: DecryptedWalletPayload = {
      version: 1,
      address: account.address,
      privateKeyHex: bytesToHex(account.privateKey),
      mnemonic: null,
    };
    encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
    payload.privateKeyHex = "";
    payload.mnemonic = null;

    const ivBuffer = copyToArrayBuffer(iv);
    const payloadBuffer = copyToArrayBuffer(encodedPayload);
    let encrypted: ArrayBuffer;
    try {
      encrypted = await cryptoObj.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuffer, tagLength: 128 },
        key,
        payloadBuffer,
      );
    } finally {
      new Uint8Array(ivBuffer).fill(0);
      new Uint8Array(payloadBuffer).fill(0);
    }
    const ciphertext = new Uint8Array(encrypted);

    return {
      format: ENCRYPTED_BACKUP_FORMAT,
      version: ENCRYPTED_BACKUP_VERSION,
      address: account.address,
      walletAddress: account.address,
      privateKey: bytesToHex(account.privateKey),
      createdAt: new Date().toISOString(),
      kdf: {
        algorithm: "PBKDF2",
        hash: "SHA-256",
        iterations: BACKUP_KDF_ITERATIONS,
        salt: encodeBase64(salt),
      },
      cipher: {
        algorithm: "AES-GCM",
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext),
      },
    };
  } finally {
    encodedPayload?.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

export function serializeEncryptedWalletBackup(
  backup: EncryptedWalletBackup,
): string {
  return JSON.stringify(backup, null, 2);
}

export async function createEncryptedWalletBackupFile(
  account: ThruAccount,
  password: string,
  options: BackupCryptoOptions = {},
): Promise<string> {
  return serializeEncryptedWalletBackup(
    await createEncryptedWalletBackup(account, password, options),
  );
}

export function parseEncryptedWalletBackup(
  serialized: string,
): ParsedEncryptedWalletBackup {
  const encoded = new TextEncoder().encode(serialized);
  try {
    if (encoded.length === 0 || encoded.length > MAX_BACKUP_FILE_BYTES) {
      throw malformedBackup();
    }
  } finally {
    encoded.fill(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw malformedBackup();
  }

  if (
    isRecord(parsed) &&
    (Object.hasOwn(parsed, "privateKeyHex") || Object.hasOwn(parsed, "mnemonic"))
  ) {
    throw new WalletBackupError(
      "LEGACY_PLAINTEXT_BACKUP",
      LEGACY_BACKUP_MESSAGE,
    );
  }

  if (!isRecord(parsed)) {
    throw malformedBackup();
  }
  if (parsed.format !== ENCRYPTED_BACKUP_FORMAT) {
    throw new WalletBackupError(
      "UNSUPPORTED_BACKUP",
      "This wallet backup format is not supported.",
    );
  }
  if (
    parsed.version !== ENCRYPTED_BACKUP_VERSION &&
    parsed.version !== LEGACY_ENCRYPTED_BACKUP_VERSION
  ) {
    throw new WalletBackupError(
      "UNSUPPORTED_BACKUP",
      "This wallet backup version is not supported.",
    );
  }
  const expectedTopLevelKeys =
    parsed.version === ENCRYPTED_BACKUP_VERSION
      ? [
          "format",
          "version",
          "address",
          "walletAddress",
          "privateKey",
          "createdAt",
          "kdf",
          "cipher",
        ]
      : ["format", "version", "walletAddress", "kdf", "cipher"];
  if (!hasOnlyKeys(parsed, expectedTopLevelKeys)) {
    throw malformedBackup();
  }
  if (
    typeof parsed.walletAddress !== "string" ||
    parsed.walletAddress.length < 8 ||
    parsed.walletAddress.length > 128
  ) {
    throw malformedBackup();
  }
  if (
    parsed.version === ENCRYPTED_BACKUP_VERSION &&
    (typeof parsed.address !== "string" ||
      parsed.address.length < 8 ||
      parsed.address.length > 128 ||
      typeof parsed.privateKey !== "string" ||
      !/^[0-9a-f]{64}$/i.test(parsed.privateKey) ||
      typeof parsed.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        parsed.createdAt,
      ) ||
      !Number.isFinite(Date.parse(parsed.createdAt)))
  ) {
    throw malformedBackup();
  }
  if (
    !isRecord(parsed.kdf) ||
    !hasOnlyKeys(parsed.kdf, [
      "algorithm",
      "hash",
      "iterations",
      "salt",
    ]) ||
    parsed.kdf.algorithm !== "PBKDF2" ||
    parsed.kdf.hash !== "SHA-256" ||
    !Number.isSafeInteger(parsed.kdf.iterations) ||
    (parsed.kdf.iterations as number) < BACKUP_KDF_MIN_ITERATIONS ||
    (parsed.kdf.iterations as number) > BACKUP_KDF_MAX_ITERATIONS
  ) {
    throw malformedBackup();
  }
  if (
    !isRecord(parsed.cipher) ||
    !hasOnlyKeys(parsed.cipher, ["algorithm", "iv", "ciphertext"]) ||
    parsed.cipher.algorithm !== "AES-GCM"
  ) {
    throw malformedBackup();
  }

  const salt = decodeBase64(parsed.kdf.salt, BACKUP_SALT_BYTES);
  const iv = decodeBase64(parsed.cipher.iv, BACKUP_IV_BYTES);
  const ciphertext = decodeBase64(
    parsed.cipher.ciphertext,
    undefined,
    MIN_CIPHERTEXT_BYTES,
    MAX_CIPHERTEXT_BYTES,
  );
  salt.fill(0);
  iv.fill(0);
  ciphertext.fill(0);

  return parsed as unknown as ParsedEncryptedWalletBackup;
}

function parseDecryptedPayload(value: unknown): DecryptedWalletPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "address",
      "privateKeyHex",
      "mnemonic",
    ]) ||
    value.version !== 1 ||
    typeof value.address !== "string" ||
    value.address.length < 8 ||
    value.address.length > 128 ||
    typeof value.privateKeyHex !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.privateKeyHex) ||
    !(
      value.mnemonic === null ||
      (typeof value.mnemonic === "string" &&
        value.mnemonic.length > 0 &&
        value.mnemonic.length <= 1_024)
    )
  ) {
    throw malformedBackup();
  }
  return value as unknown as DecryptedWalletPayload;
}

export async function decryptEncryptedWalletBackup(
  serialized: string,
  password: string,
  options: Pick<BackupCryptoOptions, "cryptoObj"> = {},
): Promise<ThruAccount> {
  const backup = parseEncryptedWalletBackup(serialized);
  const cryptoObj = getCrypto(options.cryptoObj);
  const salt = decodeBase64(backup.kdf.salt, BACKUP_SALT_BYTES);
  const iv = decodeBase64(backup.cipher.iv, BACKUP_IV_BYTES);
  const ciphertext = decodeBase64(
    backup.cipher.ciphertext,
    undefined,
    MIN_CIPHERTEXT_BYTES,
    MAX_CIPHERTEXT_BYTES,
  );
  let decryptedBytes: Uint8Array | null = null;
  let privateKeyBytes: Uint8Array | null = null;
  let account: ThruAccount | null = null;
  let mnemonicAccount: ThruAccount | null = null;
  let plaintextAccount: ThruAccount | null = null;
  let plaintextPrivateKeyBytes: Uint8Array | null = null;
  let payload: DecryptedWalletPayload | null = null;
  let succeeded = false;

  try {
    const key = await deriveBackupKey(
      password,
      salt,
      backup.kdf.iterations,
      ["decrypt"],
      cryptoObj,
    );
    let decrypted: ArrayBuffer;
    const ivBuffer = copyToArrayBuffer(iv);
    const ciphertextBuffer = copyToArrayBuffer(ciphertext);
    try {
      decrypted = await cryptoObj.subtle.decrypt(
        { name: "AES-GCM", iv: ivBuffer, tagLength: 128 },
        key,
        ciphertextBuffer,
      );
    } catch {
      throw new WalletBackupError(
        "DECRYPTION_FAILED",
        "Unable to decrypt this backup. Check the password and file.",
      );
    } finally {
      new Uint8Array(ivBuffer).fill(0);
      new Uint8Array(ciphertextBuffer).fill(0);
    }

    decryptedBytes = new Uint8Array(decrypted);
    let parsedPayload: unknown;
    try {
      const decryptedText = new TextDecoder("utf-8", { fatal: true }).decode(
        decryptedBytes,
      );
      parsedPayload = JSON.parse(decryptedText);
    } catch {
      throw malformedBackup();
    }
    payload = parseDecryptedPayload(parsedPayload);

    privateKeyBytes = hexToBytes(payload.privateKeyHex);
    account = await accountFromPrivateKey(privateKeyBytes);
    if (
      account.address !== backup.walletAddress ||
      account.address !== payload.address
    ) {
      throw new WalletBackupError(
        "ADDRESS_MISMATCH",
        "This backup file does not match its wallet address.",
      );
    }

    if (backup.version === ENCRYPTED_BACKUP_VERSION) {
      plaintextPrivateKeyBytes = hexToBytes(backup.privateKey);
      plaintextAccount = await accountFromPrivateKey(
        plaintextPrivateKeyBytes,
      );
      if (
        backup.address !== backup.walletAddress ||
        plaintextAccount.address !== backup.address ||
        plaintextAccount.address !== account.address ||
        !bytesEqual(plaintextAccount.publicKey, account.publicKey) ||
        !bytesEqual(plaintextAccount.privateKey, account.privateKey)
      ) {
        throw new WalletBackupError(
          "ADDRESS_MISMATCH",
          "This backup file does not match its wallet address.",
        );
      }
    }

    if (payload.mnemonic !== null) {
      try {
        mnemonicAccount = await accountFromMnemonic(payload.mnemonic);
      } catch {
        throw malformedBackup();
      }
      if (
        mnemonicAccount.address !== account.address ||
        !bytesEqual(mnemonicAccount.publicKey, account.publicKey) ||
        !bytesEqual(mnemonicAccount.privateKey, account.privateKey)
      ) {
        throw new WalletBackupError(
          "ADDRESS_MISMATCH",
          "This backup file does not match its wallet address.",
        );
      }
      account.mnemonic = payload.mnemonic;
    }

    await assertAccountIdentity(account);
    succeeded = true;
    return account;
  } finally {
    salt.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    decryptedBytes?.fill(0);
    privateKeyBytes?.fill(0);
    plaintextPrivateKeyBytes?.fill(0);
    if (payload) {
      payload.privateKeyHex = "";
      payload.mnemonic = null;
    }
    mnemonicAccount?.privateKey.fill(0);
    if (mnemonicAccount) mnemonicAccount.mnemonic = undefined;
    plaintextAccount?.privateKey.fill(0);
    if (plaintextAccount) plaintextAccount.mnemonic = undefined;
    if (!succeeded) {
      account?.privateKey.fill(0);
      if (account) account.mnemonic = undefined;
    }
  }
}

export async function readEncryptedBackupFile(
  file: Pick<File, "size" | "text">,
): Promise<string> {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_BACKUP_FILE_BYTES
  ) {
    throw malformedBackup();
  }
  const contents = await file.text();
  parseEncryptedWalletBackup(contents);
  return contents;
}

export async function downloadEncryptedWalletBackup(
  account: ThruAccount,
  password: string,
): Promise<void> {
  const contents = await createEncryptedWalletBackupFile(account, password);
  const blob = new Blob([contents], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = createWalletBackupFilename(account.address);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createWalletBackupFilename(
  address: string,
  createdAt = new Date(),
): string {
  const safeAddress = address.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const timestamp = createdAt
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `thru-wallet-${safeAddress}-${timestamp}.json`;
}
