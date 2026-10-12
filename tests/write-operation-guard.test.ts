import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConsensusStatus, EOA_PROGRAM_ID, Pubkey, Signature, Transaction } from "@thru/sdk";
import { thru } from "../lib/thru/client";
import { THRU_NETWORK } from "../lib/thru/network";
import { withWalletWriteGuard, reserveGuardedSubmission, WriteOperationBlockedError, type WriteLockProvider } from "../lib/thru/write-operation-guard";
import { submitSignedTransactionOnce } from "../lib/thru/transactions";
import { buildNativeTransferInstruction, NATIVE_TRANSFER_HEADER } from "../lib/wallet/native-transfer-validation";
import { persistNativeTransfer, type NativeJournalStorage } from "../lib/wallet/pending-native-transfer";
import { ensureAccountExists, type ThruAccount } from "../lib/wallet/thru-wallet";
import { withdrawFromFaucet } from "../lib/wallet/faucet";
import { createTokenOnBetanet, resumeTokenSetupOnBetanet, createDestinationTokenAccountOnBetanet, mintAdditionalSupplyOnBetanet, transferTokensOnBetanet } from "../lib/token/thru-token";

const wallet = Pubkey.from(new Uint8Array(32).fill(83)).toThruFmt();
const recipient = Pubkey.from(new Uint8Array(32).fill(84)).toThruFmt();
const signature = Signature.from(new Uint8Array(64).fill(85));
const execution = {
  vmError: 0, userErrorCode: 0n, executionResult: 0n,
  consumedComputeUnits: 1, consumedMemoryUnits: 1, consumedStateUnits: 0,
  pagesUsed: 0, eventsCount: 0, eventsSize: 0, readwriteAccounts: [], readonlyAccounts: [], errorProgramAccIdx: 0,
};
function storage(): NativeJournalStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function locks(): WriteLockProvider {
  let busy = false;
  return { async request(name, options, work) {
    assert.equal(name, "thru.write:betanet:2");
    assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
    if (busy) return work(null);
    busy = true;
    try { return await work({}); } finally { busy = false; }
  } };
}
function browser(t: TestContext, lockProvider: WriteLockProvider, journal: NativeJournalStorage): void {
  for (const [key, value] of Object.entries({ window: { localStorage: journal }, document: {}, navigator: { locks: lockProvider } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
}
function signedPublicModel(): Transaction {
  // Synthetic signature is a non-secret RPC-shape fixture, never submitted to a network.
  const transaction = new Transaction({ feePayer: wallet, program: EOA_PROGRAM_ID,
    header: { ...NATIVE_TRANSFER_HEADER, nonce: 3n, startSlot: 100n, chainId: 2 },
    accounts: { readWriteAccounts: [Pubkey.from(recipient).toBytes()] }, instructionData: buildNativeTransferInstruction(1n) });
  transaction.setSignature(signature);
  return transaction;
}
test("wallet/network guard rejects concurrent tabs and does not queue stale intents", async () => {
  const lockProvider = locks();
  const journal = storage();
  let done: (() => void) | undefined;
  const active = withWalletWriteGuard(wallet, () => new Promise<void>((resolve) => { done = resolve; }), { required: true, locks: lockProvider, storage: journal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let secondRan = false;
  await assert.rejects(withWalletWriteGuard(wallet, async () => { secondRan = true; }, { required: true, locks: lockProvider, storage: journal }), WriteOperationBlockedError);
  assert.equal(secondRan, false);
  done?.();
  await active;
});
test("actual account/faucet/token entrypoints use the same browser write lock", async (t) => {
  const lockProvider = locks();
  browser(t, lockProvider, storage());
  // Only public address/key shape is needed: guard must reject before touching signing material or RPC.
  const account: ThruAccount = { address: wallet, publicKey: Pubkey.from(wallet).toBytes(), privateKey: new Uint8Array(0) };
  const progress = () => {};
  await withWalletWriteGuard(wallet, async () => {
    for (const action of [
      () => ensureAccountExists(account),
      () => withdrawFromFaucet(account),
      () => createTokenOnBetanet(account, { name: "Guard fixture", ticker: "FIX", decimals: 6, initialSupply: "1" }, { onProgress: progress }),
      () => resumeTokenSetupOnBetanet(account, { mintAddress: recipient, initialSupply: "1" }, { onProgress: progress }),
      () => createDestinationTokenAccountOnBetanet(account, { mintAddress: recipient, destinationOwnerAddress: recipient }, { onProgress: progress }),
      () => mintAdditionalSupplyOnBetanet(account, { mintAddress: recipient, destinationAddress: recipient, amount: "1" }, { onProgress: progress }),
      () => transferTokensOnBetanet(account, { sourceAddress: wallet, destinationAddress: recipient, amount: "1" }, { onProgress: progress }),
    ]) await assert.rejects(action(), WriteOperationBlockedError);
  });
});
test("nested faucet/account-create lease avoids deadlock and forged leases are rejected", async () => {
  const lockProvider = locks();
  const journal = storage();
  await withWalletWriteGuard(wallet, async (lease) => {
    const nested = await withWalletWriteGuard(wallet, async () => "verified", {}, lease);
    assert.equal(nested, "verified");
    await assert.rejects(withWalletWriteGuard(recipient, async () => {}, {}, lease), WriteOperationBlockedError);
  }, { required: true, locks: lockProvider, storage: journal });
  await assert.rejects(withWalletWriteGuard(wallet, async () => {}, {}, { walletAddress: wallet }), WriteOperationBlockedError);
});
test("unresolved native record also prevents existing faucet/token writers", async (t) => {
  const journal = storage();
  browser(t, locks(), journal);
  persistNativeTransfer({ version: 1, network: THRU_NETWORK.storageScope, walletAddress: wallet, recipientAddress: recipient,
    amountRaw: "1", nonce: "3", startSlot: "100", signature: signature.toThruFmt(), bodyHash: "0".repeat(64), createdAt: 0, status: "uncertain" }, journal);
  const account: ThruAccount = { address: wallet, publicKey: Pubkey.from(wallet).toBytes(), privateKey: new Uint8Array(0) };
  await assert.rejects(withdrawFromFaucet(account), WriteOperationBlockedError);
  await assert.rejects(transferTokensOnBetanet(account, { sourceAddress: wallet, destinationAddress: recipient, amount: "1" }, { onProgress: () => {} }), WriteOperationBlockedError);
});
test("common unary boundary durably fences an uncertain token/faucet write before one send", async (t) => {
  const journal = storage();
  const lockProvider = locks();
  let sends = 0;
  await withWalletWriteGuard(wallet, async () => {
    await assert.rejects(submitSignedTransactionOnce({ rawTransaction: signedPublicModel().toWire(), expectedSignature: signature.toThruFmt(),
      send: async () => { sends++; throw new Error("transport refused"); } }));
  }, { required: true, locks: lockProvider, storage: journal });
  const previous = thru.transactions.getStatus;
  thru.transactions.getStatus = async () => { throw new Error("not_found"); };
  t.after(() => { thru.transactions.getStatus = previous; });
  await assert.rejects(withWalletWriteGuard(wallet, async () => { sends++; }, { required: true, locks: locks(), storage: journal }), WriteOperationBlockedError);
  assert.equal(sends, 1);
});
test("a definitive public status can release a prior writer fence without re-send", async (t) => {
  const journal = storage();
  await withWalletWriteGuard(wallet, async () => { reserveGuardedSubmission(signedPublicModel().toWire(), signature.toThruFmt()); }, { required: true, locks: locks(), storage: journal });
  const previous = thru.transactions.getStatus;
  thru.transactions.getStatus = async () => ({ signature: signature.toBytes(), statusCode: ConsensusStatus.CLUSTER_EXECUTED,
    executionResult: execution });
  t.after(() => { thru.transactions.getStatus = previous; });
  let safeNext = false;
  await withWalletWriteGuard(wallet, async () => { safeNext = true; }, { required: true, locks: locks(), storage: journal });
  assert.equal(safeNext, true);
});
test("fence signature mismatch or INCLUDED status cannot unlock another writer", async (t) => {
  const previous = thru.transactions.getStatus;
  t.after(() => { thru.transactions.getStatus = previous; });
  for (const mismatch of [true, false]) {
    const journal = storage();
    await withWalletWriteGuard(wallet, async () => { reserveGuardedSubmission(signedPublicModel().toWire(), signature.toThruFmt()); }, { required: true, locks: locks(), storage: journal });
    thru.transactions.getStatus = async () => ({ signature: mismatch ? new Uint8Array(64).fill(86) : signature.toBytes(),
      statusCode: mismatch ? ConsensusStatus.FINALIZED : ConsensusStatus.INCLUDED,
      executionResult: execution });
    await assert.rejects(withWalletWriteGuard(wallet, async () => {}, { required: true, locks: locks(), storage: journal }), WriteOperationBlockedError);
  }
});
test("fence storage failure at the shared boundary prevents a token/faucet send", async () => {
  const journal = storage();
  let sends = 0;
  await withWalletWriteGuard(wallet, async () => {
    journal.setItem = () => { throw new Error("SecurityError"); };
    await assert.rejects(submitSignedTransactionOnce({ rawTransaction: signedPublicModel().toWire(), expectedSignature: signature.toThruFmt(), send: async () => { sends++; return signature.toThruFmt(); } }), WriteOperationBlockedError);
  }, { required: true, locks: locks(), storage: journal });
  assert.equal(sends, 0);
});

test("cleanup failure retains the write fence without falsifying authoritative execution", async () => {
  const journal = storage();
  const write = journal.setItem;
  journal.setItem = (key, value) => { if (value === "null") throw new Error("Quota"); write(key, value); };
  let sends = 0;
  await withWalletWriteGuard(wallet, async () => {
    const result = await submitSignedTransactionOnce({ rawTransaction: signedPublicModel().toWire(), expectedSignature: signature.toThruFmt(),
      send: async () => { sends++; return signature.toThruFmt(); },
      getStatus: async () => ({ signature: signature.toBytes(), statusCode: ConsensusStatus.FINALIZED, executionResult: execution }),
    });
    assert.equal(result.finalized, true);
    assert.equal(result.executionSucceeded, true);
  }, { required: true, locks: locks(), storage: journal });
  assert.equal(sends, 1);
});
