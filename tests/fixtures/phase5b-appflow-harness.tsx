// PUBLIC, NON-FUNDED TEST FIXTURES ONLY. Never use these identities on a network.
// This entry point is bundled only by the isolated test; it is not an app route.
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Account, ConsensusStatus, Pubkey, Transaction, keys } from "@thru/sdk";
import AppFlow from "../../components/AppFlow";
import { accountFromPrivateKey, bytesToHex } from "../../lib/wallet/thru-wallet";
import { saveAndVerifyPersistedWallet, restorePersistedWallet, removePersistedWallet,
  WALLET_VAULT_DB_NAME, STORE_ENCRYPTED_WALLET, STORE_DEVICE_KEY, RECORD_KEY,
} from "../../lib/wallet/persistent-wallet";
import { createEncryptedWalletBackupFile, decryptEncryptedWalletBackupContents } from "../../lib/wallet/wallet-backup";
import { TOKEN_PORTFOLIO_STORAGE_KEY } from "../../lib/token/portfolio";
import { NATIVE_SEND_ENABLED } from "../../lib/wallet/native-transfer-controller";

const counters = { height: 0, inventory: 0, account: 0, history: 0, generate: 0, forbidden: 0,
  downloads: 0, objectURLs: 0, revokedURLs: 0, removals: 0 };
const fixtureBytes = (identity: "a" | "b") => new Uint8Array(32).fill(identity === "a" ? 71 : 72);
let identity: "a" | "b" = "a";
let holdGeneration: (() => void) | null = null;
let generationGate: Promise<void> | null = null;
let root: Root | null = null;
let lastBlob: Blob | null = null;
let encryptedWriteFailure = false;
let deleteFailure = false;
let catalogFailure = false;
const nativeBalance: bigint | null = 0n;
let holdVerification = false;
let writeObserved = false;
let resumeVerification: ((fail?: boolean) => void) | null = null;
let abortStore: string | null = null;
const fixturePassword = "public-test-fixture-password";

const forbid = () => { counters.forbidden++; throw new Error("Isolated QA forbids signing or submission."); };
Transaction.prototype.sign = forbid;
Transaction.prototype.legacySign = forbid;
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
  if (encryptedWriteFailure && this.name === STORE_ENCRYPTED_WALLET) throw new DOMException("Synthetic write denied", "QuotaExceededError");
  const request = originalPut.apply(this, args);
  if (abortStore === this.name) {
    abortStore = null;
    request.addEventListener("success", () => this.transaction.abort(), { once: true });
  }
  if (holdVerification && this.name === STORE_ENCRYPTED_WALLET) request.addEventListener("success", () => { writeObserved = true; });
  return request;
};
const originalGet = IDBObjectStore.prototype.get;
IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore["get"]>) {
  const request = originalGet.apply(this, args);
  if (this.name === STORE_ENCRYPTED_WALLET) request.addEventListener("success", (event) => {
    if (!holdVerification || !writeObserved) return;
    holdVerification = false;
    event.stopImmediatePropagation();
    resumeVerification = (fail = false) => {
      if (fail) request.onerror?.call(request, new Event("error"));
      else request.onsuccess?.call(request, event);
      resumeVerification = null;
    };
  });
  return request;
};
const originalDelete = IDBObjectStore.prototype.delete;
const originalTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
  const names = Array.isArray(args[0]) ? args[0] : [args[0]];
  if (args[1] === "readwrite" && names.includes(STORE_ENCRYPTED_WALLET) && names.includes(STORE_DEVICE_KEY)) counters.removals++;
  return originalTransaction.apply(this, args);
};
IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore["delete"]>) {
  if (deleteFailure && this.name === STORE_ENCRYPTED_WALLET) throw new DOMException("Synthetic delete denied", "SecurityError");
  return originalDelete.apply(this, args);
};
const originalSet = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (catalogFailure && key === TOKEN_PORTFOLIO_STORAGE_KEY) throw new DOMException("Synthetic catalog full", "QuotaExceededError");
  return originalSet.call(this, key, value);
};
const createURL = URL.createObjectURL.bind(URL);
const revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { counters.objectURLs++; lastBlob = blob instanceof Blob ? blob : null; return createURL(blob); };
URL.revokeObjectURL = (url) => { counters.revokedURLs++; revokeURL(url); };
const click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download) { counters.downloads++; return; }
  return click.call(this);
};

async function publicAccount(address: string) {
  counters.account++;
  if (nativeBalance === null) throw new Error("Synthetic account unavailable");
  return { address: Pubkey.from(address), consensusStatus: ConsensusStatus.FINALIZED,
    versionContext: { slot: 100n, seq: 1n }, meta: { balance: nativeBalance, seq: 1n,
      flags: { isNew: false, isDeleted: false, isEphemeral: false, isCompressed: false } },
  } as Account;
}

// Only the external client boundary is replaced. Wallet, IDB, hooks, discovery,
// model, dialogs and AppFlow itself are actual production implementations.
export const boundary = {
  keys: { fromPrivateKey: keys.fromPrivateKey, generateKeyPair: async () => {
    counters.generate++;
    if (generationGate) await generationGate;
    return accountFromPrivateKey(fixtureBytes(identity));
  } },
  blocks: { getBlockHeight: async () => { counters.height++; return { finalized: 100n, locallyExecuted: 101n, clusterExecuted: 101n }; }, get: forbid },
  accounts: { get: publicAccount, list: async () => { counters.inventory++; return { accounts: [], nextPageToken: undefined }; }, create: forbid },
  transactions: { listForAccount: async () => { counters.history++; return { transactions: [], nextPageToken: undefined }; },
    send: forbid, sendAndTrack: forbid, getStatus: forbid, get: forbid },
  proofs: { generate: forbid },
};

async function fixtureBackup(version: 1 | 2, mode: "valid" | "tampered" | "identity" = "valid") {
  const wallet = await accountFromPrivateKey(fixtureBytes(identity));
  try {
    const backup = JSON.parse(await createEncryptedWalletBackupFile(wallet, fixturePassword, { createdTokens: [{
      mintAddress: Pubkey.from(new Uint8Array(32).fill(83)).toThruFmt(), walletAddress: wallet.address,
      creatorAddress: wallet.address, label: "Public QA catalog", ticker: "QA", decimals: 6, tokenAccountAddresses: [],
    }] }));
    if (mode === "tampered") backup.cipher.ciphertext = (backup.cipher.ciphertext[0] === "A" ? "B" : "A") + backup.cipher.ciphertext.slice(1);
    if (mode === "identity") backup.walletAddress = Pubkey.from(new Uint8Array(32).fill(84)).toThruFmt();
    return version === 1 ? JSON.stringify({ format: backup.format, version: 1,
      walletAddress: backup.walletAddress, kdf: backup.kdf, cipher: backup.cipher }) : JSON.stringify(backup);
  } finally { wallet.privateKey.fill(0); }
}

async function mutateVault(mode: "schema" | "missing-key") {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(WALLET_VAULT_DB_NAME);
    request.onerror = () => reject(new Error("Fixture storage failed"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction([STORE_ENCRYPTED_WALLET, STORE_DEVICE_KEY], "readwrite");
      if (mode === "missing-key") tx.objectStore(STORE_DEVICE_KEY).delete(RECORD_KEY);
      else {
        const store = tx.objectStore(STORE_ENCRYPTED_WALLET);
        const get = store.get(RECORD_KEY);
        get.onsuccess = () => store.put({ ...get.result, version: 999 }, RECORD_KEY);
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(new Error("Fixture storage failed")); };
    };
  });
}

export interface AppFlowQA {
  mount(): void; unmount(): void;
  stats(): typeof counters;
  seed(identity: "a" | "b", pending?: boolean): Promise<void>;
  select(identity: "a" | "b"): void;
  stored(): Promise<{ present: boolean; matches: boolean; pending: boolean }>;
  reset(): Promise<void>;
  writeFailure(enabled: boolean): void; deletionFailure(enabled: boolean): void; catalogFailure(enabled: boolean): void;
  mutateVault(mode: "schema" | "missing-key"): Promise<void>;
  generationHold(): void; releaseGeneration(): void;
  persistenceHold(): void; verificationHeld(): boolean; releaseVerification(fail?: boolean): void;
  abortWrite(store: "device" | "wallet"): void;
  restoreHold(): void;
  publicIdentities(): Promise<{ a: string; b: string }>;
  fillPrivateImport(): void;
  importFile(version: 1 | 2, mode?: "valid" | "tampered" | "identity", wrongPassword?: boolean): Promise<void>;
  fillBackupPasswords(mismatch?: boolean): void;
  downloadSummary(): Promise<{ fields: string[]; plaintextKeyMatches: boolean; encryptedPayload: boolean; catalog: boolean; revoked: boolean }>;
  inputsEmpty(): boolean;
  nativeGate(): boolean;
}

function setReactInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

declare global { interface Window { phase5bApp: AppFlowQA } }
window.phase5bApp = {
  mount() { root = createRoot(document.getElementById("root")!); root.render(<AppFlow />); },
  unmount() { root?.unmount(); root = null; },
  stats: () => ({ ...counters }),
  select: (next) => { identity = next; },
  async seed(next, pending = false) {
    identity = next;
    const account = await accountFromPrivateKey(fixtureBytes(next));
    try { await saveAndVerifyPersistedWallet(account, { setupPending: pending }); }
    finally { account.privateKey.fill(0); }
  },
  async stored() {
    const account = await restorePersistedWallet();
    const expected = await accountFromPrivateKey(fixtureBytes(identity));
    try { return { present: !!account, matches: account?.address === expected.address,
      pending: account ? await (await import("../../lib/wallet/persistent-wallet")).isPersistedWalletSetupPending(account.address) : false }; }
    finally { account?.privateKey.fill(0); expected.privateKey.fill(0); }
  },
  async reset() {
    root?.unmount(); root = null;
    encryptedWriteFailure = deleteFailure = catalogFailure = false;
    abortStore = null;
    await removePersistedWallet(); localStorage.clear(); sessionStorage.clear();
    lastBlob = null;
  },
  writeFailure: (enabled) => { encryptedWriteFailure = enabled; },
  deletionFailure: (enabled) => { deleteFailure = enabled; },
  catalogFailure: (enabled) => { catalogFailure = enabled; },
  mutateVault,
  generationHold() { generationGate = new Promise((resolve) => { holdGeneration = resolve; }); },
  releaseGeneration() { generationGate = null; holdGeneration?.(); holdGeneration = null; },
  persistenceHold() { holdVerification = true; writeObserved = false; },
  restoreHold() { holdVerification = true; writeObserved = true; },
  verificationHeld: () => resumeVerification !== null,
  releaseVerification: (fail = false) => { resumeVerification?.(fail); },
  abortWrite: (store) => { abortStore = store === "device" ? STORE_DEVICE_KEY : STORE_ENCRYPTED_WALLET; },
  async publicIdentities() {
    const a = await accountFromPrivateKey(fixtureBytes("a")), b = await accountFromPrivateKey(fixtureBytes("b"));
    try { return { a: a.address, b: b.address }; }
    finally { a.privateKey.fill(0); b.privateKey.fill(0); }
  },
  fillPrivateImport() {
    const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, bytesToHex(fixtureBytes(identity)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  async importFile(version, mode = "valid", wrongPassword = false) {
    const serialized = await fixtureBackup(version, mode);
    const transfer = new DataTransfer();
    transfer.items.add(new File([serialized], "public-qa-backup.json", { type: "application/json" }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    setReactInput(document.querySelector<HTMLInputElement>('input[placeholder="Backup password"]')!,
      wrongPassword ? "wrong-public-test-password" : fixturePassword);
  },
  fillBackupPasswords(mismatch = false) {
    const inputs = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="password"]');
    setReactInput(inputs[0], fixturePassword); setReactInput(inputs[1], mismatch ? "mismatch-public-test" : fixturePassword);
  },
  async downloadSummary() {
    if (!lastBlob) throw new Error("No test-only download captured");
    const contents = await lastBlob.text();
    const parsed = JSON.parse(contents);
    const wallet = await accountFromPrivateKey(fixtureBytes(identity));
    const restored = await decryptEncryptedWalletBackupContents(contents, fixturePassword);
    try { return { fields: Object.keys(parsed).sort(), plaintextKeyMatches: parsed.privateKey === bytesToHex(wallet.privateKey),
      encryptedPayload: typeof parsed.cipher.ciphertext === "string" && parsed.version === 2,
      catalog: restored.createdTokens.length > 0, revoked: counters.objectURLs === counters.revokedURLs }; }
    finally { wallet.privateKey.fill(0); restored.account.privateKey.fill(0); }
  },
  inputsEmpty: () => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="password"],input[type="file"],textarea'))
    .every((input) => input.value === ""),
  nativeGate: () => NATIVE_SEND_ENABLED,
};
