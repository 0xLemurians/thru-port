import {
  type ThruAccount,
  accountFromPrivateKey,
  bytesToHex,
  hexToBytes,
} from "./thru-wallet";

export const WALLET_VAULT_DB_NAME = "thru-port-wallet";
export const WALLET_VAULT_VERSION = 1;
export const STORE_ENCRYPTED_WALLET = "encryptedWallet";
export const STORE_DEVICE_KEY = "deviceKey";
export const RECORD_KEY = "current";

export interface PersistedWalletRecord {
  version: number;
  walletAddress: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  createdAt: number;
}

export interface PersistenceOptions {
  idb?: IDBFactory | null;
  cryptoObj?: Crypto | null;
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

export async function savePersistedWallet(
  account: ThruAccount,
  options: PersistenceOptions = {},
): Promise<void> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  const cryptoObj =
    options.cryptoObj !== undefined ? options.cryptoObj : getCrypto();
  if (!idb || !cryptoObj || !cryptoObj.subtle) {
    throw new Error(
      "Secure client-side storage is not available in this browser.",
    );
  }

  const db = await openVaultDB(idb);
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

    const ivBytes = new Uint8Array(12);
    cryptoObj.getRandomValues(ivBytes);

    const payloadObj = {
      address: account.address,
      privateKeyHex: bytesToHex(account.privateKey),
      mnemonic: account.mnemonic || null,
    };
    const encodedPayload = new TextEncoder().encode(
      JSON.stringify(payloadObj),
    );

    const ciphertext = await cryptoObj.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes },
      deviceKey,
      encodedPayload,
    );

    const record: PersistedWalletRecord = {
      version: 1,
      walletAddress: account.address,
      iv: ivBytes.buffer.slice(
        ivBytes.byteOffset,
        ivBytes.byteOffset + ivBytes.byteLength,
      ),
      ciphertext,
      createdAt: Date.now(),
    };

    await idbPut(db, STORE_ENCRYPTED_WALLET, record, RECORD_KEY);
  } finally {
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
    return null;
  }

  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    return null;
  }

  try {
    const record = (await idbGet(
      db,
      STORE_ENCRYPTED_WALLET,
      RECORD_KEY,
    )) as PersistedWalletRecord | null;
    if (!record) {
      return null;
    }

    if (record.version !== 1) {
      throw new Error(
        `Unknown wallet vault version (${record.version}). Please import your backup file.`,
      );
    }

    const deviceKey = (await idbGet(
      db,
      STORE_DEVICE_KEY,
      RECORD_KEY,
    )) as CryptoKey | null;
    if (!deviceKey) {
      throw new Error(
        "Device encryption key is missing or corrupted. Please import your backup file.",
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
      throw new Error(
        "Failed to decrypt saved wallet. Data may be corrupted or key mismatch.",
      );
    }

    const decryptedText = new TextDecoder().decode(decryptedBuffer);
    const payload = JSON.parse(decryptedText) as {
      address?: string;
      privateKeyHex?: string;
      mnemonic?: string | null;
    };
    if (
      !payload ||
      typeof payload.privateKeyHex !== "string" ||
      !payload.address
    ) {
      throw new Error("Corrupted wallet payload.");
    }

    const privateKeyBytes = hexToBytes(payload.privateKeyHex);
    const account = await accountFromPrivateKey(privateKeyBytes);
    privateKeyBytes.fill(0);

    if (
      account.address !== record.walletAddress ||
      account.address !== payload.address
    ) {
      throw new Error("Wallet address mismatch in restored data.");
    }

    if (payload.mnemonic && typeof payload.mnemonic === "string") {
      account.mnemonic = payload.mnemonic;
    }

    return account;
  } finally {
    db.close();
  }
}

export async function removePersistedWallet(
  options: PersistenceOptions = {},
): Promise<void> {
  const idb = options.idb !== undefined ? options.idb : getIDB();
  if (!idb) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openVaultDB(idb);
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(
          [STORE_ENCRYPTED_WALLET, STORE_DEVICE_KEY],
          "readwrite",
        );
        tx.objectStore(STORE_ENCRYPTED_WALLET).delete(RECORD_KEY);
        tx.objectStore(STORE_DEVICE_KEY).delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error || new Error("Failed to remove vault data"));
      } catch (err) {
        reject(err);
      }
    });
  } finally {
    db.close();
  }
}
