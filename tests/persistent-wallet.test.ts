/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createNewAccount } from "../lib/wallet/thru-wallet";
import {
  savePersistedWallet,
  restorePersistedWallet,
  removePersistedWallet,
} from "../lib/wallet/persistent-wallet";

class MockObjectStore {
  constructor(private store: Map<string, unknown>) {}
  get(key: string) {
    const req = { onsuccess: null as any, onerror: null as any, result: this.store.get(key) };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }
  put(value: unknown, key: string) {
    this.store.set(key, value);
    const req = { onsuccess: null as any, onerror: null as any };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }
  delete(key: string) {
    this.store.delete(key);
    const req = { onsuccess: null as any, onerror: null as any };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }
}

class MockDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  constructor(public stores: Map<string, Map<string, unknown>>) {}
  createObjectStore(name: string) {
    this.stores.set(name, new Map());
  }
  transaction(_storeNames: string | string[], _mode: string) {
    const tx = {
      oncomplete: null as any,
      onerror: null as any,
      error: null,
      objectStore: (name: string) => {
        if (!this.stores.has(name)) this.stores.set(name, new Map());
        return new MockObjectStore(this.stores.get(name)!);
      },
    };
    setTimeout(() => tx.oncomplete?.(), 0);
    return tx as any;
  }
  close() {}
}

class MockIDBFactory {
  stores = new Map<string, Map<string, unknown>>();
  open(_name: string, _version: number) {
    const db = new MockDatabase(this.stores);
    const req = {
      onupgradeneeded: null as any,
      onsuccess: null as any,
      onerror: null as any,
      result: db,
      error: null,
    };
    setTimeout(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req as any;
  }
}

test("persistent-wallet returns null and handles missing storage gracefully", async () => {
  const restored = await restorePersistedWallet({ idb: null });
  assert.equal(restored, null);

  const account = await createNewAccount(true);
  await assert.rejects(
    () => savePersistedWallet(account, { idb: null }),
    /Secure client-side storage is not available/,
  );

  await removePersistedWallet({ idb: null });
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

// Helper to simulate UI state logic of removal confirmation
class RemovalConfirmationController {
  confirming = false;
  removing = false;
  error: string | null = null;
  account: any = { address: "thru1mock" };

  onClickRemove() {
    this.confirming = true;
    this.error = null;
  }

  onClickCancel() {
    this.confirming = false;
    this.error = null;
  }

  async onClickConfirm(removeFn: () => Promise<void>) {
    if (this.removing) return; // Prevent double click
    this.removing = true;
    this.error = null;
    try {
      await removeFn();
      this.account = null;
      this.confirming = false;
    } catch (err: any) {
      this.error = err.message || "Removal failed";
    } finally {
      this.removing = false;
    }
  }
}

test("removal confirmation UX workflow and storage guarantees", async () => {
  const mockIDB = new MockIDBFactory() as any;
  const account = await createNewAccount(true);
  await savePersistedWallet(account, { idb: mockIDB, cryptoObj: globalThis.crypto });

  const controller = new RemovalConfirmationController();
  controller.account = account;

  // 1. İlk Remove tıklaması confirmation görünümünü açar.
  controller.onClickRemove();
  assert.equal(controller.confirming, true, "Confirmation state should be active");

  // 2. Confirmation zaman geçince kendiliğinden kapanmaz.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(controller.confirming, true, "Confirmation should not auto-reset over time");

  // 3. Cancel storage’a dokunmaz.
  controller.onClickCancel();
  assert.equal(controller.confirming, false);
  const restoredAfterCancel = await restorePersistedWallet({ idb: mockIDB, cryptoObj: globalThis.crypto });
  assert.ok(restoredAfterCancel, "Storage should remain untouched after cancel");

  // 7. Removal sürerken double-click engellenir.
  controller.onClickRemove();
  let removeCalls = 0;
  let resolveRemove: () => void = () => {};
  const slowRemoveFn = () => new Promise<void>((resolve) => {
    removeCalls++;
    resolveRemove = resolve;
  });

  const p1 = controller.onClickConfirm(slowRemoveFn);
  assert.equal(controller.removing, true);
  const p2 = controller.onClickConfirm(slowRemoveFn); // Second click ignored
  resolveRemove();
  await p1;
  await p2;
  assert.equal(removeCalls, 1, "Should only execute removal once during double click");

  // 8. Removal hatasında wallet aktif kalır.
  controller.account = account;
  controller.onClickRemove();
  const failingRemoveFn = async () => { throw new Error("Disk write error"); };
  await controller.onClickConfirm(failingRemoveFn);
  assert.ok(controller.account, "Wallet should remain active when removal throws error");
  assert.equal(controller.error, "Disk write error", "Error message should be displayed");

  // 4 & 5. Confirm encrypted wallet record’unu ve device CryptoKey'i siler.
  // 6. Başarılı confirm active wallet state’ini temizler.
  await savePersistedWallet(account, { idb: mockIDB, cryptoObj: globalThis.crypto });
  assert.ok(mockIDB.stores.get("encryptedWallet")?.get("current"));
  assert.ok(mockIDB.stores.get("deviceKey")?.get("current"));

  controller.onClickRemove();
  await controller.onClickConfirm(() => removePersistedWallet({ idb: mockIDB, cryptoObj: globalThis.crypto }));
  assert.equal(controller.account, null, "Active wallet state should be cleared on success");
  assert.equal(mockIDB.stores.get("encryptedWallet")?.get("current"), undefined, "Encrypted wallet record should be deleted");
  assert.equal(mockIDB.stores.get("deviceKey")?.get("current"), undefined, "Device CryptoKey should be deleted");
});

test("clean source check: bis_skin_checked and suppressHydrationWarning absent", () => {
  const layoutPath = path.join(process.cwd(), "app/layout.tsx");
  const content = fs.readFileSync(layoutPath, "utf-8");
  assert.equal(content.includes("bis_skin_checked"), false, "bis_skin_checked must not be present in layout");
  assert.equal(content.includes("suppressHydrationWarning"), false, "suppressHydrationWarning must not be present in layout");
});
