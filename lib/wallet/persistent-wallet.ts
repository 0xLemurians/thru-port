import {
  type ThruAccount,
  accountFromPrivateKey,
  assertAccountIdentity,
  bytesToHex,
  hexToBytes,
} from "./thru-wallet";

export const WALLET_VAULT_DB_NAME = "thru-port-wallet";
export const WALLET_VAULT_VERSION = 1;
export const STORE_ENCRYPTED_WALLET = "encryptedWallet";
export const STORE_DEVICE_KEY = "deviceKey";
export const RECORD_KEY = "current";
export const SAVED_WALLET_OPEN_ERROR =
  "The saved wallet could not be opened on this device.";
export const WALLET_REMOVAL_ERROR =
  "Unable to remove the wallet from this device. Try again.";
export const WALLET_SAVE_ERROR =
  "Unable to save the wallet securely on this device.";

export type WalletVaultErrorCode =
  | "VAULT_UNAVAILABLE"
  | "VAULT_OPEN_FAILED"
  | "VAULT_READ_FAILED"
  | "VAULT_CORRUPTED"
  | "VAULT_SAVE_FAILED"
  | "VAULT_VERIFICATION_FAILED"
  | "VAULT_DELETE_FAILED"
  | "VAULT_DELETE_VERIFICATION_FAILED";

export class WalletVaultError extends Error {
  constructor(
    public readonly code: WalletVaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletVaultError";
  }
}

export interface PersistedWalletRecord {
  version: 1 | 2;
  walletAddress: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  createdAt: number;
  setupPending?: boolean;
}

interface PersistedWalletPayload {
  address?: string;
  privateKeyHex?: string;
  mnemonic?: string | null;
}

export interface PersistenceOptions {
  idb?: IDBFactory | null;
  cryptoObj?: Crypto | null;
  setupPending?: boolean;
}

function getIDB(): IDBFactory | null {
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  if (typeof globalThis !== "undefined" && globalThis.indexedDB) {
    return globalThis.indexedDB;
  }
  return null;
}

function getCrypto(): Crypto | null {
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  if (typeof globalThis !== "undefined" && globalThis.crypto) {
    return globalThis.crypto;
  }
  return null;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function openVaultDB(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = idb.open(WALLET_VAULT_DB_NAME, WALLET_VAULT_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ENCRYPTED_WALLET)) {
          db.createObjectStore(STORE_ENCRYPTED_WALLET);
        }
        if (!db.objectStoreNames.contains(STORE_DEVICE_KEY)) {
          db.createObjectStore(STORE_DEVICE_KEY);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error || new Error("Failed to open wallet vault DB"));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbGet(
  db: IDBDatabase,
  storeName: string,
  key: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () =>
        reject(req.error || new Error(`Failed to get from ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbPut(
  db: IDBDatabase,
  storeName: string,
  value: unknown,
  key: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          tx.error || req.error || new Error(`Failed to put to ${storeName}`),
        );
      req.onerror = () =>
        reject(req.error || new Error(`Failed to put to ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}

function secureBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function walletAccountsMatch(
  left: ThruAccount,
  right: ThruAccount,
): boolean {
  return (
    left.address === right.address &&
    secureBytesEqual(left.publicKey, right.publicKey) &&
    secureBytesEqual(left.privateKey, right.privateKey) &&
    (left.mnemonic ?? null) === (right.mnemonic ?? null)
  );
}

export async function savePersistedWallet(
  account: ThruAccount,
  options: PersistenceOptions = {},
): Promise<void> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  const cryptoObj =
    options.cryptoObj !== undefined ? options.cryptoObj : getCrypto();
  if (!idb || !cryptoObj || !cryptoObj.subtle) {
    throw new WalletVaultError(
      "VAULT_UNAVAILABLE",
      WALLET_SAVE_ERROR,
    );
  }

  await assertAccountIdentity(account).catch(() => {
    throw new WalletVaultError("VAULT_SAVE_FAILED", WALLET_SAVE_ERROR);
  });

  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    throw new WalletVaultError("VAULT_OPEN_FAILED", WALLET_SAVE_ERROR);
  }
  let encodedPayload: Uint8Array | null = null;
  let ivBytes: Uint8Array | null = null;
  try {
    let deviceKey = (await idbGet(
      db,
      STORE_DEVICE_KEY,
      RECORD_KEY,
    )) as CryptoKey | null;
    if (!deviceKey) {
      deviceKey = await cryptoObj.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await idbPut(db, STORE_DEVICE_KEY, deviceKey, RECORD_KEY);
    }

    ivBytes = new Uint8Array(12);
    cryptoObj.getRandomValues(ivBytes);

    const payloadObj: {
      address: string;
      privateKeyHex: string;
      mnemonic: string | null;
    } = {
      address: account.address,
      privateKeyHex: bytesToHex(account.privateKey),
      mnemonic: account.mnemonic || null,
    };
    encodedPayload = new TextEncoder().encode(
      JSON.stringify(payloadObj),
    );
    payloadObj.privateKeyHex = "";
    payloadObj.mnemonic = null;

    const ivBuffer = copyToArrayBuffer(ivBytes);
    const payloadBuffer = copyToArrayBuffer(encodedPayload);
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await cryptoObj.subtle.encrypt(
        { name: "AES-GCM", iv: ivBuffer },
        deviceKey,
        payloadBuffer,
      );
    } finally {
      new Uint8Array(payloadBuffer).fill(0);
    }

    const record: PersistedWalletRecord = {
      version: 2,
      walletAddress: account.address,
      iv: ivBuffer,
      ciphertext,
      createdAt: Date.now(),
      setupPending: options.setupPending === true,
    };

    await idbPut(db, STORE_ENCRYPTED_WALLET, record, RECORD_KEY);
  } catch (error) {
    if (error instanceof WalletVaultError) throw error;
    throw new WalletVaultError("VAULT_SAVE_FAILED", WALLET_SAVE_ERROR);
  } finally {
    encodedPayload?.fill(0);
    ivBytes?.fill(0);
    db.close();
  }
}

export async function restorePersistedWallet(
  options: PersistenceOptions = {},
): Promise<ThruAccount | null> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  const cryptoObj =
    options.cryptoObj !== undefined ? options.cryptoObj : getCrypto();
  if (!idb || !cryptoObj || !cryptoObj.subtle) {
    throw new WalletVaultError("VAULT_UNAVAILABLE", SAVED_WALLET_OPEN_ERROR);
  }

  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    throw new WalletVaultError("VAULT_OPEN_FAILED", SAVED_WALLET_OPEN_ERROR);
  }

  let decryptedBytes: Uint8Array | null = null;
  let privateKeyBytes: Uint8Array | null = null;
  let account: ThruAccount | null = null;
  let payload: PersistedWalletPayload | null = null;
  let succeeded = false;
  try {
    let record: PersistedWalletRecord | null;
    try {
      record = (await idbGet(
        db,
        STORE_ENCRYPTED_WALLET,
        RECORD_KEY,
      )) as PersistedWalletRecord | null;
    } catch {
      throw new WalletVaultError(
        "VAULT_READ_FAILED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }
    if (!record) {
      return null;
    }

    if (
      typeof record !== "object" ||
      (record.version !== 1 && record.version !== 2) ||
      typeof record.walletAddress !== "string" ||
      !(record.iv instanceof ArrayBuffer) ||
      record.iv.byteLength !== 12 ||
      !(record.ciphertext instanceof ArrayBuffer) ||
      record.ciphertext.byteLength < 16 ||
      (record.version === 2 && typeof record.setupPending !== "boolean")
    ) {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }

    let deviceKey: CryptoKey | null;
    try {
      deviceKey = (await idbGet(
        db,
        STORE_DEVICE_KEY,
        RECORD_KEY,
      )) as CryptoKey | null;
    } catch {
      throw new WalletVaultError(
        "VAULT_READ_FAILED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }
    if (!deviceKey) {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }

    let decryptedBuffer: ArrayBuffer;
    try {
      decryptedBuffer = await cryptoObj.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(record.iv) },
        deviceKey,
        record.ciphertext,
      );
    } catch {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }

    decryptedBytes = new Uint8Array(decryptedBuffer);
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(decryptedBytes),
      ) as PersistedWalletPayload;
    } catch {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }
    if (
      !payload ||
      typeof payload.privateKeyHex !== "string" ||
      !/^[0-9a-f]{64}$/i.test(payload.privateKeyHex) ||
      typeof payload.address !== "string" ||
      !(
        payload.mnemonic === null ||
        payload.mnemonic === undefined ||
        (typeof payload.mnemonic === "string" &&
          payload.mnemonic.length > 0 &&
          payload.mnemonic.length <= 1_024)
      )
    ) {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }

    privateKeyBytes = hexToBytes(payload.privateKeyHex);
    account = await accountFromPrivateKey(privateKeyBytes);

    if (
      account.address !== record.walletAddress ||
      account.address !== payload.address
    ) {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }

    if (payload.mnemonic && typeof payload.mnemonic === "string") {
      account.mnemonic = payload.mnemonic;
    }

    await assertAccountIdentity(account).catch(() => {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    });
    succeeded = true;
    return account;
  } catch (error) {
    if (error instanceof WalletVaultError) throw error;
    throw new WalletVaultError("VAULT_CORRUPTED", SAVED_WALLET_OPEN_ERROR);
  } finally {
    decryptedBytes?.fill(0);
    privateKeyBytes?.fill(0);
    if (payload) {
      payload.privateKeyHex = "";
      payload.mnemonic = null;
    }
    if (!succeeded) {
      account?.privateKey.fill(0);
      if (account) account.mnemonic = undefined;
    }
    db.close();
  }
}

export async function saveAndVerifyPersistedWallet(
  account: ThruAccount,
  options: PersistenceOptions = {},
): Promise<ThruAccount> {
  await savePersistedWallet(account, options);
  const restored = await restorePersistedWallet(options);
  const setupPending = restored
    ? await isPersistedWalletSetupPending(restored.address, options)
    : false;
  if (
    !restored ||
    !walletAccountsMatch(account, restored) ||
    setupPending !== (options.setupPending === true)
  ) {
    restored?.privateKey.fill(0);
    if (restored) restored.mnemonic = undefined;
    throw new WalletVaultError(
      "VAULT_VERIFICATION_FAILED",
      WALLET_SAVE_ERROR,
    );
  }
  return restored;
}

export async function isPersistedWalletSetupPending(
  walletAddress: string,
  options: PersistenceOptions = {},
): Promise<boolean> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  if (!idb) {
    throw new WalletVaultError("VAULT_UNAVAILABLE", SAVED_WALLET_OPEN_ERROR);
  }

  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    throw new WalletVaultError("VAULT_OPEN_FAILED", SAVED_WALLET_OPEN_ERROR);
  }

  try {
    let record: PersistedWalletRecord | null;
    try {
      record = (await idbGet(
        db,
        STORE_ENCRYPTED_WALLET,
        RECORD_KEY,
      )) as PersistedWalletRecord | null;
    } catch {
      throw new WalletVaultError(
        "VAULT_READ_FAILED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }
    if (!record) return false;
    if (
      typeof record !== "object" ||
      (record.version !== 1 && record.version !== 2) ||
      record.walletAddress !== walletAddress ||
      (record.version === 2 && typeof record.setupPending !== "boolean")
    ) {
      throw new WalletVaultError(
        "VAULT_CORRUPTED",
        SAVED_WALLET_OPEN_ERROR,
      );
    }
    return record.version === 2 && record.setupPending === true;
  } finally {
    db.close();
  }
}

export async function completePersistedWalletSetup(
  walletAddress: string,
  options: PersistenceOptions = {},
): Promise<void> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  if (!idb) {
    throw new WalletVaultError("VAULT_UNAVAILABLE", WALLET_SAVE_ERROR);
  }

  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    throw new WalletVaultError("VAULT_OPEN_FAILED", WALLET_SAVE_ERROR);
  }

  try {
    let record: PersistedWalletRecord | null;
    try {
      record = (await idbGet(
        db,
        STORE_ENCRYPTED_WALLET,
        RECORD_KEY,
      )) as PersistedWalletRecord | null;
    } catch {
      throw new WalletVaultError("VAULT_READ_FAILED", WALLET_SAVE_ERROR);
    }
    if (
      !record ||
      typeof record !== "object" ||
      record.version !== 2 ||
      record.walletAddress !== walletAddress ||
      record.setupPending !== true
    ) {
      throw new WalletVaultError("VAULT_CORRUPTED", WALLET_SAVE_ERROR);
    }

    await idbPut(
      db,
      STORE_ENCRYPTED_WALLET,
      { ...record, setupPending: false },
      RECORD_KEY,
    ).catch(() => {
      throw new WalletVaultError("VAULT_SAVE_FAILED", WALLET_SAVE_ERROR);
    });

    let verified: PersistedWalletRecord | null;
    try {
      verified = (await idbGet(
        db,
        STORE_ENCRYPTED_WALLET,
        RECORD_KEY,
      )) as PersistedWalletRecord | null;
    } catch {
      throw new WalletVaultError(
        "VAULT_VERIFICATION_FAILED",
        WALLET_SAVE_ERROR,
      );
    }
    if (
      !verified ||
      verified.version !== 2 ||
      verified.walletAddress !== walletAddress ||
      verified.setupPending !== false
    ) {
      throw new WalletVaultError(
        "VAULT_VERIFICATION_FAILED",
        WALLET_SAVE_ERROR,
      );
    }
  } finally {
    db.close();
  }
}

export async function removePersistedWallet(
  options: PersistenceOptions = {},
): Promise<void> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  if (!idb) {
    throw new WalletVaultError("VAULT_UNAVAILABLE", WALLET_REMOVAL_ERROR);
  }
  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    throw new WalletVaultError("VAULT_OPEN_FAILED", WALLET_REMOVAL_ERROR);
  }
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(
            [STORE_ENCRYPTED_WALLET, STORE_DEVICE_KEY],
            "readwrite",
          );
          const walletRequest = tx
            .objectStore(STORE_ENCRYPTED_WALLET)
            .delete(RECORD_KEY);
          const keyRequest = tx.objectStore(STORE_DEVICE_KEY).delete(RECORD_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(tx.error || new Error("Wallet vault deletion failed"));
          tx.onabort = () =>
            reject(tx.error || new Error("Wallet vault deletion was aborted"));
          walletRequest.onerror = () =>
            reject(
              walletRequest.error ||
                new Error("Encrypted wallet deletion failed"),
            );
          keyRequest.onerror = () =>
            reject(
              keyRequest.error || new Error("Device key deletion failed"),
            );
        } catch (error) {
          reject(error);
        }
      });
    } catch {
      throw new WalletVaultError(
        "VAULT_DELETE_FAILED",
        WALLET_REMOVAL_ERROR,
      );
    }

    let walletRecord: unknown;
    let deviceKey: unknown;
    try {
      [walletRecord, deviceKey] = await Promise.all([
        idbGet(db, STORE_ENCRYPTED_WALLET, RECORD_KEY),
        idbGet(db, STORE_DEVICE_KEY, RECORD_KEY),
      ]);
    } catch {
      throw new WalletVaultError(
        "VAULT_DELETE_VERIFICATION_FAILED",
        WALLET_REMOVAL_ERROR,
      );
    }
    if (walletRecord !== null || deviceKey !== null) {
      throw new WalletVaultError(
        "VAULT_DELETE_VERIFICATION_FAILED",
        WALLET_REMOVAL_ERROR,
      );
    }
  } finally {
    db.close();
  }
}
