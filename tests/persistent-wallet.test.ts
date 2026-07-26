/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createNewAccount } from "../lib/wallet/thru-wallet";
import {
  SAVED_WALLET_OPEN_ERROR,
  WALLET_REMOVAL_ERROR,
  WalletVaultError,
  savePersistedWallet,
  saveAndVerifyPersistedWallet,
  restorePersistedWallet,
  removePersistedWallet,
} from "../lib/wallet/persistent-wallet";

interface MockIDBBehavior {
  failOpen?: boolean;
  failRead?: boolean;
  failDelete?: boolean;
  retainDeletedRecords?: boolean;
}

class MockObjectStore {
  constructor(
    private store: Map<string, unknown>,
    private behavior: MockIDBBehavior,
  ) {}
  get(key: string) {
    const req = {
      onsuccess: null as any,
      onerror: null as any,
      result: this.store.get(key),
      error: this.behavior.failRead ? new Error("mock read failure") : null,
    };
    setTimeout(() => {
      if (this.behavior.failRead) req.onerror?.();
      else req.onsuccess?.();
    }, 0);
    return req;
  }
  put(value: unknown, key: string) {
    this.store.set(key, value);
    const req = { onsuccess: null as any, onerror: null as any };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }
  delete(key: string) {
    if (
      !this.behavior.failDelete &&
      !this.behavior.retainDeletedRecords
    ) {
      this.store.delete(key);
    }
    const req = {
      onsuccess: null as any,
      onerror: null as any,
      error: this.behavior.failDelete
        ? new Error("mock delete failure")
        : null,
    };
    setTimeout(() => {
      if (this.behavior.failDelete) req.onerror?.();
      else req.onsuccess?.();
    }, 0);
    return req;
  }
}

class MockDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(
    public stores: Map<string, Map<string, unknown>>,
    private behavior: MockIDBBehavior,
  ) {}
  createObjectStore(name: string) {
    this.stores.set(name, new Map());
  }
  transaction(_storeNames: string | string[], _mode: string) {
    const tx = {
      oncomplete: null as any,
      onerror: null as any,
      onabort: null as any,
      error: null as Error | null,
      objectStore: (name: string) => {
        if (!this.stores.has(name)) this.stores.set(name, new Map());
        return new MockObjectStore(this.stores.get(name)!, this.behavior);
      },
    };
    setTimeout(() => {
      if (
        this.behavior.failDelete &&
        Array.isArray(_storeNames) &&
        _storeNames.includes("encryptedWallet")
      ) {
        tx.error = new Error("mock delete transaction failure");
        tx.onerror?.();
      } else {
        tx.oncomplete?.();
      }
    }, 0);
    return tx as any;
  }
  close() {}
}

class MockIDBFactory {
  stores = new Map<string, Map<string, unknown>>();
  constructor(public behavior: MockIDBBehavior = {}) {}
  open(_name: string, _version: number) {
    const db = new MockDatabase(this.stores, this.behavior);
    const req = {
      onupgradeneeded: null as any,
      onsuccess: null as any,
      onerror: null as any,
      result: db,
      error: this.behavior.failOpen ? new Error("mock open failure") : null,
    };
    setTimeout(() => {
      if (this.behavior.failOpen) {
        req.onerror?.();
        return;
      }
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req as any;
  }
}

test("persistent-wallet distinguishes unavailable storage from a missing wallet", async () => {
  await assert.rejects(
    () => restorePersistedWallet({ idb: null }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_UNAVAILABLE" &&
      error.message === SAVED_WALLET_OPEN_ERROR,
  );
  const account = await createNewAccount(true);
  await assert.rejects(
    () => savePersistedWallet(account, { idb: null }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_UNAVAILABLE",
  );
  await assert.rejects(
    () => removePersistedWallet({ idb: null }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_UNAVAILABLE" &&
      error.message === WALLET_REMOVAL_ERROR,
  );
  account.privateKey.fill(0);
  account.mnemonic = undefined;

  const emptyIDB = new MockIDBFactory() as any;
  assert.equal(
    await restorePersistedWallet({
      idb: emptyIDB,
      cryptoObj: globalThis.crypto,
    }),
    null,
  );
});

test("persistent-wallet encrypts and saves account to IDB without raw secrets", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  assert.ok(account.mnemonic);

  await savePersistedWallet(account, { idb: mockIDB, cryptoObj: globalThis.crypto });

  const storeMap = mockIDB.stores.get("encryptedWallet");
  assert.ok(storeMap, "Store should be created in IDB");
  const record = storeMap.get("current") as any;
  assert.ok(record, "Encrypted record should be stored");

  assert.equal(record.walletAddress, account.address);
  assert.ok(record.ciphertext instanceof ArrayBuffer);
  assert.ok(record.iv instanceof ArrayBuffer);

  const recordStr = JSON.stringify(record);
  assert.equal(recordStr.includes(account.mnemonic), false, "Raw mnemonic MUST NOT be stored in plaintext");
  assert.equal(recordStr.includes("privateKeyHex"), false, "Raw private key hex MUST NOT be stored in plaintext");
});

test("persistent-wallet restores exact account from IDB and wipes on remove", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  await savePersistedWallet(account, { idb: mockIDB, cryptoObj: globalThis.crypto });

  const restored = await restorePersistedWallet({ idb: mockIDB, cryptoObj: globalThis.crypto });
  assert.ok(restored, "Should successfully restore account");
  assert.equal(restored.address, account.address);
  assert.equal(restored.mnemonic, account.mnemonic);
  assert.deepEqual(restored.privateKey, account.privateKey);

  await removePersistedWallet({ idb: mockIDB, cryptoObj: globalThis.crypto });
  const afterRemove = await restorePersistedWallet({ idb: mockIDB, cryptoObj: globalThis.crypto });
  assert.equal(afterRemove, null, "Account should be null after removePersistedWallet");
});

test("saveAndVerifyPersistedWallet returns the exact verified signing wallet", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  const verified = await saveAndVerifyPersistedWallet(account, {
    idb: mockIDB,
    cryptoObj: globalThis.crypto,
  });

  assert.equal(verified.address, account.address);
  assert.deepEqual(verified.publicKey, account.publicKey);
  assert.deepEqual(verified.privateKey, account.privateKey);
  assert.equal(verified.mnemonic, account.mnemonic);
  verified.privateKey.fill(0);
  verified.mnemonic = undefined;
  account.privateKey.fill(0);
  account.mnemonic = undefined;
});

test("restore reports a typed vault-open failure without creating records", async () => {
  const mockIDB = new MockIDBFactory({ failOpen: true }) as any;
  await assert.rejects(
    () =>
      restorePersistedWallet({
        idb: mockIDB,
        cryptoObj: globalThis.crypto,
      }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_OPEN_FAILED" &&
      error.message === SAVED_WALLET_OPEN_ERROR,
  );
  assert.equal(mockIDB.stores.size, 0);
});

test("restore reports a typed vault-read failure rather than no wallet", async () => {
  const mockIDB = new MockIDBFactory({ failRead: true }) as any;
  await assert.rejects(
    () =>
      restorePersistedWallet({
        idb: mockIDB,
        cryptoObj: globalThis.crypto,
      }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_READ_FAILED",
  );
});

test("removal reports a typed vault-open failure", async () => {
  const mockIDB = new MockIDBFactory({ failOpen: true }) as any;
  await assert.rejects(
    () => removePersistedWallet({ idb: mockIDB }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_OPEN_FAILED" &&
      error.message === WALLET_REMOVAL_ERROR,
  );
});

test("deletion failure preserves both wallet vault records", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  await savePersistedWallet(account, {
    idb: mockIDB,
    cryptoObj: globalThis.crypto,
  });
  mockIDB.behavior.failDelete = true;

  await assert.rejects(
    () => removePersistedWallet({ idb: mockIDB }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_DELETE_FAILED",
  );
  assert.ok(mockIDB.stores.get("encryptedWallet")?.get("current"));
  assert.ok(mockIDB.stores.get("deviceKey")?.get("current"));
  account.privateKey.fill(0);
  account.mnemonic = undefined;
});

test("removal fails when deleted records cannot be verified absent", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  await savePersistedWallet(account, {
    idb: mockIDB,
    cryptoObj: globalThis.crypto,
  });
  mockIDB.behavior.retainDeletedRecords = true;

  await assert.rejects(
    () => removePersistedWallet({ idb: mockIDB }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_DELETE_VERIFICATION_FAILED",
  );
  assert.ok(mockIDB.stores.get("encryptedWallet")?.get("current"));
  assert.ok(mockIDB.stores.get("deviceKey")?.get("current"));
  account.privateKey.fill(0);
  account.mnemonic = undefined;
});

test("corrupted vault data returns a typed failure without overwriting it", async () => {
  const mockIDB = new MockIDBFactory() as any;
  mockIDB.stores.set(
    "encryptedWallet",
    new Map([["current", { version: 99 }]]),
  );
  const original = mockIDB.stores.get("encryptedWallet")?.get("current");

  await assert.rejects(
    () =>
      restorePersistedWallet({
        idb: mockIDB,
        cryptoObj: globalThis.crypto,
      }),
    (error: unknown) =>
      error instanceof WalletVaultError &&
      error.code === "VAULT_CORRUPTED",
  );
  assert.equal(
    mockIDB.stores.get("encryptedWallet")?.get("current"),
    original,
  );
});

test("AppFlow clears the active wallet only after verified vault removal", () => {
  const appFlowSource = fs.readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  const removalCall = appFlowSource.indexOf("await removePersistedWallet()");
  const activeClear = appFlowSource.indexOf("setAccount(null)", removalCall);

  assert.ok(removalCall >= 0, "production removal call is present");
  assert.ok(
    activeClear > removalCall,
    "active wallet is cleared only after production removal resolves",
  );
  assert.match(appFlowSource, /removalPromiseRef\.current/);
  assert.match(appFlowSource, /throw new Error\(WALLET_REMOVAL_ERROR\)/);
});

test("clean source check: bis_skin_checked and suppressHydrationWarning absent", () => {
  const layoutPath = path.join(process.cwd(), "app/layout.tsx");
  const content = fs.readFileSync(layoutPath, "utf-8");
  assert.equal(content.includes("bis_skin_checked"), false, "bis_skin_checked must not be present in layout");
  assert.equal(content.includes("suppressHydrationWarning"), false, "suppressHydrationWarning must not be present in layout");
});
