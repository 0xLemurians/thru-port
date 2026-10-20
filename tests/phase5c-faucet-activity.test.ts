import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { Account, ConsensusStatus, Pubkey, Signature, Transaction } from "@thru/sdk";
import { thru } from "../lib/thru/client";
import { loadActivityPage, type ActivityReader } from "../lib/thru/activity";
import {
  withWalletWriteGuard, reserveGuardedSubmission, WriteOperationBlockedError,
  type WriteLockProvider,
} from "../lib/thru/write-operation-guard";
import { THRU_NETWORK } from "../lib/thru/network";
import {
  canonicalTokenOperationKey, loadPendingTokenOperations,
  reconcilePendingTokenOperationJournal, savePendingTokenOperations,
  type PendingTokenOperationRecord,
} from "../lib/token/pending-operation";
import {
  FAUCET_ACCOUNT_ADDRESS, FAUCET_PROGRAM_ADDRESS, FAUCET_WITHDRAW_LIMIT,
  FAUCET_TRANSACTION_RESOURCES, buildFaucetWithdrawInstruction, withdrawFromFaucet,
} from "../lib/wallet/faucet";
import {
  SAFE_FAUCET_UNAVAILABLE_MESSAGE, SAFE_FAUCET_UNCERTAIN_MESSAGE,
  SAFE_FAUCET_ERROR_MESSAGE,
} from "../lib/wallet/faucet-safety";
import type { ThruAccount } from "../lib/wallet/thru-wallet";
import type { NativeJournalStorage } from "../lib/wallet/pending-native-transfer";

// Public, non-funded account/signature shapes only. No key generation,
// derivation or cryptographic signing is performed by this integration suite.
const wallet = Pubkey.from(new Uint8Array(32).fill(121)).toThruFmt();
const mint = Pubkey.from(new Uint8Array(32).fill(122)).toThruFmt();
const source = Pubkey.from(new Uint8Array(32).fill(123)).toThruFmt();
const destination = Pubkey.from(new Uint8Array(32).fill(124)).toThruFmt();
const signature = Signature.from(new Uint8Array(64).fill(125));
const account: ThruAccount = {
  address: wallet, publicKey: Pubkey.from(wallet).toBytes(), privateKey: new Uint8Array(0),
};
const success = {
  vmError: 0, userErrorCode: 0n, executionResult: 0n,
  consumedComputeUnits: 1, consumedMemoryUnits: 1, consumedStateUnits: 0,
  pagesUsed: 0, eventsCount: 0, eventsSize: 0,
  readwriteAccounts: [], readonlyAccounts: [], errorProgramAccIdx: 0,
};

let deniedNetworkAttempts = 0;
const original = {
  fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get,
  httpsRequest: https.request, httpsGet: https.get, connect: net.Socket.prototype.connect,
};
before(() => {
  const deny = () => {
    deniedNetworkAttempts += 1;
    throw new Error("Phase 5C fake-RPC tests forbid all real network transport.");
  };
  globalThis.fetch = deny;
  http.request = deny; http.get = deny;
  https.request = deny; https.get = deny;
  net.Socket.prototype.connect = deny;
  syncBuiltinESMExports();
});
after(() => {
  globalThis.fetch = original.fetch;
  http.request = original.httpRequest; http.get = original.httpGet;
  https.request = original.httpsRequest; https.get = original.httpsGet;
  net.Socket.prototype.connect = original.connect;
  syncBuiltinESMExports();
  assert.equal(deniedNetworkAttempts, 0, "All exercised RPC operations must remain intercepted.");
});

function publicAccount(address: string, balance: bigint, owner = FAUCET_PROGRAM_ADDRESS): Account {
  return {
    address: Pubkey.from(address), consensusStatus: ConsensusStatus.INCLUDED,
    meta: {
      balance, owner: Pubkey.from(owner),
      flags: { isDeleted: false, isProgram: address === FAUCET_PROGRAM_ADDRESS },
    },
  } as Account;
}

function signedModel(): Transaction {
  const transaction = new Transaction({
    feePayer: wallet, program: FAUCET_PROGRAM_ADDRESS,
    header: { ...FAUCET_TRANSACTION_RESOURCES, fee: 0n, nonce: 1n,
      startSlot: 100n, chainId: THRU_NETWORK.expectedChainId, expiryAfter: 100 },
    accounts: { readWriteAccounts: [FAUCET_ACCOUNT_ADDRESS] },
    instructionData: buildFaucetWithdrawInstruction(2, 0, FAUCET_WITHDRAW_LIMIT),
  });
  transaction.setSignature(signature);
  return transaction;
}

function mockFaucet(t: TestContext) {
  const counts = { build: 0, sign: 0, send: 0, status: 0, finalizedRead: 0, accountRead: 0 };
  const state = {
    balance: 0n,
    deployment: "available" as "available" | "missing-program" | "missing-vault" | "wrong-owner" | "empty-vault",
    status: "success" as "success" | "missing" | "failure",
    finalized: "missing" as "success" | "missing" | "failure",
    finalizedVisibilityDelay: 0,
    onSend: undefined as (() => void) | undefined,
  };
  t.mock.method(thru.accounts, "get", async (address: string) => {
    counts.accountRead += 1;
    if (address === FAUCET_PROGRAM_ADDRESS) {
      if (state.deployment === "missing-program") throw new Error("Synthetic missing deployment");
      return publicAccount(address, 0n);
    }
    if (address === FAUCET_ACCOUNT_ADDRESS) {
      if (state.deployment === "missing-vault") throw new Error("Synthetic missing vault");
      return publicAccount(address, state.deployment === "empty-vault" ? 0n : 100_000n,
        state.deployment === "wrong-owner" ? mint : FAUCET_PROGRAM_ADDRESS);
    }
    assert.equal(address, wallet, "The active wallet must remain the recipient.");
    return publicAccount(address, state.balance);
  });
  t.mock.method(thru.accounts, "create", async () => {
    throw new Error("This already-existing fixture account must not be created again.");
  });
  t.mock.method(thru.transactions, "build", async () => {
    counts.build += 1;
    const transaction = signedModel();
    transaction.sign = async () => { counts.sign += 1; return signature; };
    return transaction;
  });
  t.mock.method(thru.transactions, "send", async () => {
    counts.send += 1;
    state.onSend?.();
    return signature.toThruFmt();
  });
  t.mock.method(thru.transactions, "getStatus", async () => {
    counts.status += 1;
    if (state.status === "missing") throw new Error("[not_found] synthetic indexing delay");
    return { signature: signature.toBytes(), statusCode: ConsensusStatus.CLUSTER_EXECUTED,
      executionResult: state.status === "failure" ? { ...success, vmError: 4 } : success };
  });
  t.mock.method(thru.transactions, "get", async (requestedSignature: string) => {
    counts.finalizedRead += 1;
    assert.equal(requestedSignature, signature.toThruFmt(), "Reconciliation must query the exact submitted faucet signature.");
    if (state.finalized === "missing" || counts.finalizedRead <= state.finalizedVisibilityDelay) {
      throw new Error("Synthetic finalized transaction unavailable");
    }
    return {
      signature,
      getSignature: () => signature,
      executionResult: state.finalized === "failure" ? { ...success, vmError: 4 } : success,
    };
  });
  t.mock.method(thru.transactions, "sendAndTrack", async () => {
    throw new Error("The streaming/broadcast path is forbidden in this integration test.");
  });
  return { counts, state };
}

for (const deployment of ["missing-program", "missing-vault", "wrong-owner", "empty-vault"] as const) {
  test(`Phase 5C F01: actual faucet preflight rejects ${deployment} before build/sign/send`, async (t) => {
    const { counts, state } = mockFaucet(t);
    state.deployment = deployment;
    const result = await withdrawFromFaucet(account);
    assert.equal(result.finalized, false);
    assert.equal(result.failureReason, SAFE_FAUCET_UNAVAILABLE_MESSAGE);
    assert.equal(result.attempts, 0);
    assert.equal(counts.build, 0); assert.equal(counts.sign, 0); assert.equal(counts.send, 0);
    assert.equal(counts.status, 0);
  });
}

test("Phase 5C F02: cancellation before faucet preflight cannot sign or submit", async (t) => {
  const { counts } = mockFaucet(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(counts.build, 0); assert.equal(counts.sign, 0); assert.equal(counts.send, 0);
});

test("Phase 5C F02: cancellation after unary submission preserves one original verified faucet result", async (t) => {
  const { counts, state } = mockFaucet(t);
  const controller = new AbortController();
  state.onSend = () => controller.abort();
  const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { signal: controller.signal });
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, true);
  assert.equal(result.attempts, 1);
  assert.equal(counts.build, 1); assert.equal(counts.sign, 1);
  assert.equal(counts.send, 1); assert.equal(counts.status, 1);
});

test("Phase 5C F02: definitive faucet execution failure wins over unrelated incoming balance", async (t) => {
  const { counts, state } = mockFaucet(t);
  state.status = "failure";
  state.onSend = () => { state.balance = FAUCET_WITHDRAW_LIMIT; };
  const result = await withdrawFromFaucet(account);
  assert.equal(result.finalized, false);
  assert.equal(result.failureReason, SAFE_FAUCET_ERROR_MESSAGE);
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(counts.send, 1);
  assert.equal(counts.finalizedRead, 0);
});

test("Phase 5C F02: unrelated incoming funds must not prove an unverified faucet transaction", async (t) => {
  const { counts, state } = mockFaucet(t);
  state.status = "missing";
  // Deliberately no successful faucet execution/status evidence: an unrelated
  // incoming transfer changes only the public account balance in the fake chain.
  state.onSend = () => { state.balance = FAUCET_WITHDRAW_LIMIT; };
  const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { timeoutMs: 1 });
  assert.equal(counts.send, 1, "No retry/rebroadcast is allowed during reconciliation.");
  assert.equal(counts.sign, 1);
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, false, "An unrelated exact incoming delta must not establish faucet success.");
  assert.equal(result.failureReason, SAFE_FAUCET_UNCERTAIN_MESSAGE);
});

test("Phase 5C-R F02: authoritative faucet execution succeeds without balance-only attribution", async (t) => {
  const { counts, state } = mockFaucet(t);
  const result = await withdrawFromFaucet(account);
  assert.equal(state.balance, 0n, "A separate account balance observation is not required to identify this verified transaction.");
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, true);
  assert.equal(result.failureReason, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(counts.build, 1); assert.equal(counts.sign, 1); assert.equal(counts.send, 1);
  assert.equal(counts.finalizedRead, 0);
});

for (const unrelatedIncrease of [0n, FAUCET_WITHDRAW_LIMIT - 1n, FAUCET_WITHDRAW_LIMIT + 1n]) {
  test(`Phase 5C-R F02: unverified faucet remains uncertain with unrelated incoming delta ${unrelatedIncrease}`, async (t) => {
    const { counts, state } = mockFaucet(t);
    state.status = "missing";
    state.onSend = () => { state.balance = unrelatedIncrease; };
    const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { timeoutMs: 5 });
    assert.equal(result.signature, signature.toThruFmt());
    assert.equal(result.finalized, false);
    assert.equal(result.failureReason, SAFE_FAUCET_UNCERTAIN_MESSAGE);
    assert.equal(result.attempts, 1);
    assert.equal(counts.build, 1); assert.equal(counts.sign, 1); assert.equal(counts.send, 1);
    assert.ok(counts.finalizedRead >= 1);
  });
}

test("Phase 5C-R F02: delayed finalized visibility verifies only the original faucet transaction", async (t) => {
  const { counts, state } = mockFaucet(t);
  state.status = "missing";
  state.finalized = "success";
  state.finalizedVisibilityDelay = 1;
  const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { timeoutMs: 350 });
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, true);
  assert.equal(result.failureReason, undefined);
  assert.equal(result.attempts, 1);
  assert.equal(counts.send, 1); assert.equal(counts.sign, 1);
  assert.equal(counts.finalizedRead, 2, "Delayed read-only visibility must not rebuild, re-sign, or resend.");
});

test("Phase 5C-R F02: finalized faucet failure wins over an exact unrelated incoming delta", async (t) => {
  const { counts, state } = mockFaucet(t);
  state.status = "missing";
  state.finalized = "failure";
  state.onSend = () => { state.balance = FAUCET_WITHDRAW_LIMIT; };
  const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { timeoutMs: 5 });
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, false);
  assert.equal(result.failureReason, SAFE_FAUCET_ERROR_MESSAGE);
  assert.equal(counts.send, 1); assert.equal(counts.sign, 1);
  assert.equal(counts.finalizedRead, 1);
});

test("Phase 5C-R F02: cancellation after submission preserves an unverified original faucet signature", async (t) => {
  const { counts, state } = mockFaucet(t);
  const controller = new AbortController();
  state.status = "missing";
  state.onSend = () => { state.balance = FAUCET_WITHDRAW_LIMIT; controller.abort(); };
  const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, { timeoutMs: 5, signal: controller.signal });
  assert.equal(result.signature, signature.toThruFmt());
  assert.equal(result.finalized, false);
  assert.equal(result.failureReason, SAFE_FAUCET_UNCERTAIN_MESSAGE);
  assert.equal(result.attempts, 1);
  assert.equal(counts.build, 1); assert.equal(counts.sign, 1); assert.equal(counts.send, 1);
});

function memoryStorage(): NativeJournalStorage {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
}

function simulatedLocks(): WriteLockProvider {
  // This is a unit-level provider, not evidence of actual Chromium Web Locks.
  let busy = false;
  return { async request(_name, _options, work) {
    if (busy) return work(null);
    busy = true;
    try { return await work({}); } finally { busy = false; }
  } };
}

function pendingRecord(now: number): PendingTokenOperationRecord {
  const key = canonicalTokenOperationKey({ operationType: "transfer", walletAddress: wallet,
    mintAddress: mint, sourceTokenAccount: source, destinationTokenAccount: destination, amountRaw: 1n });
  return { schemaVersion: 1, key, operationType: "transfer", signature: signature.toThruFmt(),
    walletAddress: wallet, mintAddress: mint, sourceTokenAccount: source,
    destinationTokenAccount: destination, amountRaw: "1", expectedPreState: { sourceBalance: "2", destinationBalance: "0" },
    expectedPostState: { sourceBalance: "1", destinationBalance: "1" },
    createdAt: now, lastCheckedAt: now, status: "uncertain" };
}

test("Phase 5C A01: empty/delayed Activity cannot release a persisted real journal and write fence", async (t) => {
  const storage = memoryStorage();
  const record = pendingRecord(Date.now());
  savePendingTokenOperations(storage, [record]);
  const locks = simulatedLocks();
  await withWalletWriteGuard(wallet, async () => {
    reserveGuardedSubmission(signedModel().toWire(), signature.toThruFmt());
  }, { locks, storage });
  let statusReads = 0, submissions = 0, historyReads = 0;
  t.mock.method(thru.transactions, "getStatus", async () => {
    statusReads += 1; throw new Error("[not_found] synthetic history/status lag");
  });
  t.mock.method(thru.transactions, "send", async () => { submissions += 1; throw new Error("Forbidden resubmission"); });
  const journalBefore = JSON.stringify(loadPendingTokenOperations(storage));
  const reader: ActivityReader = {
    listForAccount: async () => { historyReads += 1; return { transactions: historyReads === 1 ? [] : [signedModel()] }; },
    getBlock: async (slot) => ({ slot }),
  };
  const empty = await loadActivityPage(wallet, null, reader);
  assert.equal(empty.entries.length, 0);
  assert.equal(JSON.stringify(loadPendingTokenOperations(storage)), journalBefore);
  await assert.rejects(withWalletWriteGuard(wallet, async () => { submissions += 1; }, { locks, storage }), WriteOperationBlockedError);
  const delayed = await loadActivityPage(wallet, null, reader);
  assert.equal(delayed.entries.length, 1);
  assert.equal(delayed.entries[0].signature, record.signature);
  assert.equal(delayed.entries[0].status, "Status unavailable");
  const outcome = await reconcilePendingTokenOperationJournal({ key: record.key, walletAddress: wallet, storage,
    verify: async () => { await thru.transactions.getStatus(record.signature); return "success"; } });
  assert.equal(outcome.outcome, "uncertain");
  const retained = loadPendingTokenOperations(storage);
  assert.equal(retained.length, 1); assert.equal(retained[0].signature, record.signature);
  await assert.rejects(withWalletWriteGuard(wallet, async () => { submissions += 1; }, { locks, storage }), WriteOperationBlockedError);
  assert.equal(historyReads, 2); assert.equal(statusReads, 3); assert.equal(submissions, 0);
  t.diagnostic("Mock-RPC integration only: empty or visible Activity is non-authoritative; original public journal/fence remains blocking with zero submissions.");
});
