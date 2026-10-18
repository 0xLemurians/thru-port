import {
  completePersistedWalletSetup,
  isPersistedWalletSetupPending,
  RECORD_KEY,
  removePersistedWallet,
  restorePersistedWallet,
  saveAndVerifyPersistedWallet,
  STORE_DEVICE_KEY,
  STORE_ENCRYPTED_WALLET,
  WALLET_VAULT_DB_NAME,
  type PersistedWalletRecord,
  WalletVaultError,
} from "../../lib/wallet/persistent-wallet";
import { accountFromPrivateKey, type ThruAccount } from "../../lib/wallet/thru-wallet";

// PUBLIC, UNFUNDED TEST FIXTURE ONLY. Never use this deterministic material on-chain.
// Values are kept inside the browser fixture and are never returned to the runner.
async function fixtureAccount(): Promise<ThruAccount> {
  const fixture = new Uint8Array(32).fill(0x42);
  try { return await accountFromPrivateKey(fixture); }
  finally { fixture.fill(0); }
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WALLET_VAULT_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("QA database open failed"));
  });
}

async function readRecord(db: IDBDatabase): Promise<PersistedWalletRecord> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_ENCRYPTED_WALLET).objectStore(STORE_ENCRYPTED_WALLET).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result as PersistedWalletRecord);
    request.onerror = () => reject(new Error("QA record read failed"));
  });
}

async function readKey(db: IDBDatabase): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_DEVICE_KEY).objectStore(STORE_DEVICE_KEY).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result as CryptoKey);
    request.onerror = () => reject(new Error("QA key read failed"));
  });
}

async function mutate(change: (record: PersistedWalletRecord, tx: IDBTransaction) => void): Promise<void> {
  const db = await database();
  try {
    const record = await readRecord(db);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_DEVICE_KEY, STORE_ENCRYPTED_WALLET], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("QA mutation aborted"));
      tx.onerror = () => reject(new Error("QA mutation failed"));
      change(record, tx);
    });
  } finally { db.close(); }
}

function clear(account: ThruAccount | null): void {
  account?.privateKey.fill(0);
  if (account) account.mnemonic = undefined;
}

async function code(operation: () => Promise<unknown>): Promise<string> {
  try { await operation(); return "RESOLVED"; }
  catch (error) { return error instanceof WalletVaultError ? error.code : "UNEXPECTED_ERROR"; }
}

async function saveFixture(setupPending = true): Promise<void> {
  const account = await fixtureAccount();
  let restored: ThruAccount | null = null;
  try { restored = await saveAndVerifyPersistedWallet(account, { setupPending }); }
  finally { clear(account); clear(restored); }
}

async function reset(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(WALLET_VAULT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("QA database cleanup failed"));
    request.onblocked = () => reject(new Error("QA database cleanup blocked"));
  });
  localStorage.clear(); sessionStorage.clear();
}

async function snapshot(): Promise<Record<string, boolean | number | string>> {
  const db = await database();
  let account: ThruAccount | null = null;
  let expected: ThruAccount | null = null;
  try {
    const record = await readRecord(db);
    const key = await readKey(db);
    account = await restorePersistedWallet();
    expected = await fixtureAccount();
    let exportRejected = false;
    try { await crypto.subtle.exportKey("raw", key); }
    catch { exportRejected = true; }
    return {
      restoredIdentityMatches: account?.address === expected.address &&
        account?.publicKey.every((value, index) => value === expected?.publicKey[index]) === true,
      extractable: key.extractable,
      exportRejected,
      algorithm: key.algorithm.name,
      deviceKeyCloned: key instanceof CryptoKey,
      ciphertextIsArrayBuffer: record.ciphertext instanceof ArrayBuffer,
      ivBytes: record.iv.byteLength,
      recordVersion: record.version,
      setupPending: await isPersistedWalletSetupPending(expected.address),
      recordHasOnlyApprovedFields: Object.keys(record).sort().join(",") ===
        "ciphertext,createdAt,iv,setupPending,version,walletAddress",
      mnemonicAbsent: account?.mnemonic === undefined,
    };
  } finally { db.close(); clear(account); clear(expected); }
}

type Corruption = "missing-device-key" | "ciphertext" | "schema" | "identity";
async function corrupt(kind: Corruption): Promise<string> {
  await reset(); await saveFixture();
  await mutate((record, tx) => {
    if (kind === "missing-device-key") tx.objectStore(STORE_DEVICE_KEY).delete(RECORD_KEY);
    else {
      if (kind === "ciphertext") new Uint8Array(record.ciphertext)[0] ^= 1;
      if (kind === "schema") Reflect.set(record, "version", 99);
      if (kind === "identity") record.walletAddress = "public-test-identity-mismatch";
      tx.objectStore(STORE_ENCRYPTED_WALLET).put(record, RECORD_KEY);
    }
  });
  return code(async () => { const restored = await restorePersistedWallet(); clear(restored); });
}

async function writeFailure(): Promise<{ code: string; originalRestores: boolean }> {
  await reset(); await saveFixture();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === STORE_ENCRYPTED_WALLET) throw new DOMException("QA quota denial", "QuotaExceededError");
    return original.call(this, value, key);
  };
  const fixture = await fixtureAccount();
  let result: string;
  try { result = await code(() => saveAndVerifyPersistedWallet(fixture)); }
  finally { IDBObjectStore.prototype.put = original; clear(fixture); }
  return { code: result, originalRestores: (await snapshot()).restoredIdentityMatches === true };
}

async function deletionAbort(): Promise<{ code: string; bothRecordsRemain: boolean; restores: boolean }> {
  await reset(); await saveFixture();
  const original = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function(key: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, key);
    if (this.name === STORE_DEVICE_KEY) {
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    }
    return request;
  };
  let result: string;
  try { result = await code(() => removePersistedWallet()); }
  finally { IDBObjectStore.prototype.delete = original; }
  const db = await database();
  try {
    return { code: result, bothRecordsRemain: Boolean(await readRecord(db)) && Boolean(await readKey(db)),
      restores: (await snapshot()).restoredIdentityMatches === true };
  } finally { db.close(); }
}

async function removal(): Promise<{ empty: boolean; unrelatedPreserved: boolean }> {
  await reset(); await saveFixture();
  localStorage.setItem("phase5b-unrelated-public-marker", "preserve");
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ENCRYPTED_WALLET, "readwrite");
      tx.objectStore(STORE_ENCRYPTED_WALLET).put({ public: true }, "unrelated-test-record");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error("QA marker failed"));
    });
    await removePersistedWallet();
    const marker = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE_ENCRYPTED_WALLET).objectStore(STORE_ENCRYPTED_WALLET).get("unrelated-test-record");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("QA marker read failed"));
    });
    return { empty: await restorePersistedWallet() === null,
      unrelatedPreserved: Boolean(marker) && localStorage.getItem("phase5b-unrelated-public-marker") === "preserve" };
  } finally { db.close(); }
}

async function setup(): Promise<{ failedCode: string; pendingAfterFailure: boolean; completeAfterVerifiedWrite: boolean }> {
  await reset(); await saveFixture();
  const account = await fixtureAccount();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (this.name === STORE_ENCRYPTED_WALLET) throw new DOMException("QA write denial", "QuotaExceededError");
    return original.call(this, value, key);
  };
  let failedCode: string;
  try { failedCode = await code(() => completePersistedWalletSetup(account.address)); }
  finally { IDBObjectStore.prototype.put = original; }
  try {
    const pendingAfterFailure = await isPersistedWalletSetupPending(account.address);
    await completePersistedWalletSetup(account.address);
    return { failedCode, pendingAfterFailure,
      completeAfterVerifiedWrite: !await isPersistedWalletSetupPending(account.address) };
  } finally { clear(account); }
}

async function readUnavailable(): Promise<{ unavailable: string; securityDenied: string }> {
  const deniedFactory = Object.create(indexedDB) as IDBFactory;
  Object.defineProperty(deniedFactory, "open", { value: () => { throw new DOMException("QA denial", "SecurityError"); } });
  return { unavailable: await code(() => restorePersistedWallet({ idb: null })),
    securityDenied: await code(() => restorePersistedWallet({ idb: deniedFactory })) };
}

async function abortSave(): Promise<{ outcome: string; recordPreserved: boolean; abortObserved: boolean }> {
  await reset(); await saveFixture();
  const originalPut = IDBObjectStore.prototype.put;
  const originalOpen = IDBFactory.prototype.open;
  const databases: IDBDatabase[] = [];
  let abortObserved = false;
  IDBFactory.prototype.open = function(name: string, version?: number) {
    const request = originalOpen.call(this, name, version);
    request.addEventListener("success", () => databases.push(request.result));
    return request;
  };
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key);
    if (this.name === STORE_ENCRYPTED_WALLET) {
      this.transaction.addEventListener("abort", () => { abortObserved = true; });
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
    }
    return request;
  };
  const fixture = await fixtureAccount();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = code(() => saveAndVerifyPersistedWallet(fixture));
    const outcome = await Promise.race([operation, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("PENDING_AFTER_ABORT"), 250); })]);
    IDBObjectStore.prototype.put = originalPut;
    IDBFactory.prototype.open = originalOpen;
    for (const db of databases) db.close();
    return { outcome, abortObserved, recordPreserved: (await snapshot()).restoredIdentityMatches === true };
  } finally {
    clearTimeout(timer); clear(fixture);
    IDBObjectStore.prototype.put = originalPut; IDBFactory.prototype.open = originalOpen;
    for (const db of databases) db.close();
  }
}

type AbortedWriteStage = "device-key" | "encrypted-record" | "setup-marker";

async function abortWrite(stage: AbortedWriteStage): Promise<{
  outcome: string;
  requestSucceeded: boolean;
  abortObserved: boolean;
  priorRecordPreserved: boolean;
  noWalletAfterDeviceKeyAbort: boolean;
  setupStillPending: boolean;
  subsequentOperationSucceeded: boolean;
  unhandledRejections: number;
}> {
  await reset();
  if (stage !== "device-key") await saveFixture();
  let priorRecord: PersistedWalletRecord | undefined;
  if (stage !== "device-key") {
    const db = await database();
    try { priorRecord = await readRecord(db); }
    finally { db.close(); }
  }
  const account = await fixtureAccount();
  const originalPut = IDBObjectStore.prototype.put;
  const originalOpen = IDBFactory.prototype.open;
  const openedDatabases: IDBDatabase[] = [];
  const targetStore = stage === "device-key" ? STORE_DEVICE_KEY : STORE_ENCRYPTED_WALLET;
  let requestSucceeded = false, abortObserved = false, unhandledRejections = 0;
  let injected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onUnhandled = () => { unhandledRejections++; };
  window.addEventListener("unhandledrejection", onUnhandled);
  IDBFactory.prototype.open = function(name: string, version?: number) {
    const request = originalOpen.call(this, name, version);
    request.addEventListener("success", () => openedDatabases.push(request.result));
    return request;
  };
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key);
    if (this.name === targetStore && !injected) {
      injected = true;
      this.transaction.addEventListener("abort", () => { abortObserved = true; }, { once: true });
      request.addEventListener("success", () => {
        requestSucceeded = true;
        this.transaction.abort();
      }, { once: true });
    }
    return request;
  };
  try {
    // This timeout is a failing-test watchdog, not a production abort workaround.
    const operation = code(async () => {
      if (stage === "setup-marker") await completePersistedWalletSetup(account.address);
      else {
        const saved = await saveAndVerifyPersistedWallet(account, { setupPending: false });
        clear(saved);
      }
    });
    const outcome = await Promise.race([operation, new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("PENDING_AFTER_ABORT"), 1_000);
    })]);
    clearTimeout(timer);
    IDBObjectStore.prototype.put = originalPut;
    IDBFactory.prototype.open = originalOpen;
    for (const db of openedDatabases) db.close();

    const db = await database();
    let priorRecordPreserved: boolean, noWalletAfterDeviceKeyAbort: boolean;
    try {
      const record = await readRecord(db);
      const key = await readKey(db);
      const previous = priorRecord;
      noWalletAfterDeviceKeyAbort = stage !== "device-key" || (!record && !key);
      priorRecordPreserved = !previous || Boolean(record &&
        record.version === previous.version && record.walletAddress === previous.walletAddress &&
        record.createdAt === previous.createdAt && record.setupPending === previous.setupPending &&
        new Uint8Array(record.iv).every((value, index) => value === new Uint8Array(previous.iv)[index]) &&
        record.ciphertext.byteLength === previous.ciphertext.byteLength &&
        new Uint8Array(record.ciphertext).every((value, index) => value === new Uint8Array(previous.ciphertext)[index]));
    } finally { db.close(); }
    const restored = await restorePersistedWallet();
    const identityPreserved = stage === "device-key" ? restored === null : restored?.address === account.address;
    clear(restored);
    const setupStillPending = stage !== "device-key" && await isPersistedWalletSetupPending(account.address);
    if (stage === "setup-marker") await completePersistedWalletSetup(account.address);
    else {
      const saved = await saveAndVerifyPersistedWallet(account, { setupPending: false });
      clear(saved);
    }
    const subsequent = await restorePersistedWallet();
    const subsequentOperationSucceeded = subsequent?.address === account.address &&
      !await isPersistedWalletSetupPending(account.address);
    clear(subsequent);
    return { outcome, requestSucceeded, abortObserved, priorRecordPreserved: priorRecordPreserved && identityPreserved,
      noWalletAfterDeviceKeyAbort, setupStillPending, subsequentOperationSucceeded, unhandledRejections };
  } finally {
    clearTimeout(timer); clear(account);
    IDBObjectStore.prototype.put = originalPut; IDBFactory.prototype.open = originalOpen;
    for (const db of openedDatabases) db.close();
    window.removeEventListener("unhandledrejection", onUnhandled);
  }
}

async function isEmpty(): Promise<boolean> {
  const restored = await restorePersistedWallet();
  const empty = restored === null;
  clear(restored);
  return empty;
}

export const storageQA = { reset, saveFixture, snapshot, corrupt, writeFailure, deletionAbort, removal, setup, readUnavailable, abortSave, abortWrite, isEmpty };
declare global { interface Window { phase5bStorage: typeof storageQA; } }
window.phase5bStorage = storageQA;
