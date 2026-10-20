import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import test, { type TestContext } from "node:test";
import { ConsensusStatus, Pubkey, Signature, Transaction } from "@thru/sdk";
import { thru } from "../lib/thru/client";
import { networkStorageKey, THRU_NETWORK } from "../lib/thru/network";
import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionIdentityError,
  SubmittedTransactionUncertainError,
  TransactionDeadlineExceededError,
  createTransactionDeadline,
  transactionExecutionOutcome,
  submitSignedTransactionOnce,
  verifySubmittedTransaction,
} from "../lib/thru/transactions";
import {
  WriteOperationBlockedError,
  withWalletWriteGuard,
  type WriteLockProvider,
} from "../lib/thru/write-operation-guard";
import {
  PENDING_TOKEN_OPERATION_STORAGE_KEY,
  canonicalTokenOperationKey,
  loadPendingTokenOperations,
  savePendingTokenOperations,
  type PendingTokenOperationRecord,
} from "../lib/token/pending-operation";
import { reconcilePendingOperation } from "../lib/token/thru-token";
import { waitForTransactionVisibility, TransactionStatusUncertainError } from "../lib/token/transaction-status";

// Public, non-funded shape fixtures only. These are not cryptographic signatures
// and are never combined with signing material or submitted to an RPC service.
const publicAddress = (byte: number) =>
  Pubkey.from(new Uint8Array(32).fill(byte)).toThruFmt();
const signatureBytes = new Uint8Array(64).fill(191);
const signature = Signature.from(signatureBytes).toThruFmt();
const successfulExecution = { vmError: 0, userErrorCode: 0n, executionResult: 0n };
const walletAddress = publicAddress(192);
const mintAddress = publicAddress(193);

type Observed<T> =
  | { kind: "returned"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "watchdog" };

/** Test-only watchdog: it bounds evidence collection, not application RPCs. */
async function observeWithin<T>(promise: Promise<T>): Promise<Observed<T>> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<Observed<T>, Observed<T>>(
        (value) => ({ kind: "returned", value }),
        (error: unknown) => ({ kind: "rejected", error }),
      ),
      new Promise<Observed<T>>((resolve) => {
        watchdog = setTimeout(() => resolve({ kind: "watchdog" }), 100);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

function memoryStorage() {
  const records = new Map<string, string>();
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
  };
}

function installStorage(t: TestContext, storage: ReturnType<typeof memoryStorage>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

function pendingRecord(createdAt = Date.now()): PendingTokenOperationRecord {
  return {
    schemaVersion: 1,
    key: canonicalTokenOperationKey({
      operationType: "transfer", walletAddress, mintAddress, amountRaw: 1n,
    }),
    operationType: "transfer",
    signature,
    walletAddress,
    mintAddress,
    amountRaw: "1",
    expectedPreState: { sourceBalance: "2", destinationBalance: "0" },
    expectedPostState: { sourceBalance: "1", destinationBalance: "1" },
    createdAt,
    lastCheckedAt: createdAt,
    status: "uncertain",
  };
}

test.beforeEach((t) => {
  if (!("mock" in t) || !("after" in t)) {
    throw new Error("Phase 5C transport guard requires a test context");
  }
  // Independent transport tripwires: every transaction/status boundary below
  // must use an explicit fake; an accidental real request fails immediately.
  let unexpectedBoundaryCalls = 0;
  const blocked = () => {
    unexpectedBoundaryCalls += 1;
    throw new Error("Phase 5C forbids external transport");
  };
  t.after(() => assert.equal(unexpectedBoundaryCalls, 0, "unexpected external or sensitive execution boundary"));
  t.mock.method(globalThis, "fetch", blocked);
  t.mock.method(http, "request", blocked);
  t.mock.method(http, "get", blocked);
  t.mock.method(https, "request", blocked);
  t.mock.method(https, "get", blocked);
  t.mock.method(thru.transactions, "send", blocked);
  t.mock.method(thru.transactions, "getStatus", blocked);
  t.mock.method(thru.transactions, "get", blocked);
  t.mock.method(thru.accounts, "get", blocked);
  t.mock.method(thru.transactions, "build", blocked);
});

test("S05: a never-settling unary send must become uncertain within its bounded deadline", async (t) => {
  let sends = 0;
  let polls = 0;
  const observed = await observeWithin(submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([1]),
    expectedSignature: signature,
    timeoutMs: 5,
    send: () => { sends += 1; return new Promise<string>(() => {}); },
    getStatus: async () => { polls += 1; throw new Error("must not poll before send settles"); },
  }));
  assert.equal(sends, 1);
  assert.equal(polls, 0);
  t.diagnostic(`fake send=${sends}; getStatus=${polls}; observation=${observed.kind}`);
  assert.notEqual(observed.kind, "watchdog", "application deadline did not settle the never-resolving send");
  if (observed.kind === "rejected") {
    assert.ok(observed.error instanceof SubmittedTransactionUncertainError);
    assert.equal(observed.error.signature, signature);
  } else if (observed.kind === "returned") {
    assert.equal(observed.value.finalized, false);
    assert.equal(observed.value.statusTimedOut, true);
  }
});

test("S05: a never-settling getStatus must not bypass the status deadline", async (t) => {
  let sends = 0;
  let polls = 0;
  const observed = await observeWithin(submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([2]),
    expectedSignature: signature,
    timeoutMs: 5,
    send: async () => { sends += 1; return signature; },
    getStatus: () => { polls += 1; return new Promise(() => {}); },
  }));
  assert.equal(sends, 1);
  assert.equal(polls, 1);
  t.diagnostic(`fake send=${sends}; getStatus=${polls}; observation=${observed.kind}`);
  assert.notEqual(observed.kind, "watchdog", "an in-flight status read bypassed the application deadline");
  if (observed.kind === "returned") assert.equal(observed.value.finalized, false);
});

test("S05: a status request that stalls after the first poll must remain deadline-bounded", async (t) => {
  let sends = 0;
  let polls = 0;
  let clock = 0;
  const observed = await observeWithin(submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([3]),
    expectedSignature: signature,
    timeoutMs: 10,
    pollIntervalMs: 1,
    now: () => clock,
    sleep: async (delay) => { clock += delay; },
    send: async () => { sends += 1; return signature; },
    getStatus: () => {
      polls += 1;
      if (polls === 1) return Promise.resolve({ signature: signatureBytes, statusCode: ConsensusStatus.INCLUDED });
      return new Promise(() => {});
    },
  }));
  assert.equal(sends, 1);
  assert.equal(polls, 2);
  t.diagnostic(`fake send=${sends}; getStatus=${polls}; observation=${observed.kind}`);
  assert.notEqual(observed.kind, "watchdog", "the second pending read prevented timeout/recovery handoff");
});

test("S05: earlier provisional execution must not fill absent execution evidence in a later final status", async () => {
  let sends = 0;
  let polls = 0;
  let clock = 0;
  const result = await submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([4]),
    expectedSignature: signature,
    timeoutMs: 10,
    pollIntervalMs: 1,
    now: () => clock,
    sleep: async (delay) => { clock += delay; },
    send: async () => { sends += 1; return signature; },
    getStatus: async () => ++polls === 1
      ? { signature: signatureBytes, statusCode: ConsensusStatus.INCLUDED, executionResult: successfulExecution }
      : { signature: signatureBytes, statusCode: ConsensusStatus.FINALIZED },
  });
  assert.equal(sends, 1);
  assert.equal(polls, 2);
  assert.equal(result.signature, signature);
  assert.equal(result.finalized, false, "missing current execution evidence must hand off to read-only verification");
  assert.equal(result.executionSucceeded, false);
});

test("S05: hung recovery post-state read must settle uncertain without clearing its journal", async (t) => {
  const storage = memoryStorage();
  installStorage(t, storage);
  const record = pendingRecord();
  savePendingTokenOperations(storage, [record]);
  let statusReads = 0;
  let finalizedReads = 0;
  let postStateReads = 0;
  let resultBuilds = 0;
  t.mock.method(thru.transactions, "getStatus", async () => {
    statusReads += 1;
    throw new Error("transaction not found");
  });
  t.mock.method(thru.transactions, "get", async () => {
    finalizedReads += 1;
    throw new Error("RPC unavailable");
  });
  const observed = await observeWithin(reconcilePendingOperation({
    base: {
      key: record.key, operationType: record.operationType, walletAddress,
      mintAddress, expectedPostState: record.expectedPostState,
    },
    verifyExpectedState: () => { postStateReads += 1; return new Promise(() => {}); },
    buildResult: async () => { resultBuilds += 1; return "must not succeed"; },
    timeoutMs: 5,
  }));
  assert.equal(statusReads, 1);
  assert.equal(finalizedReads, 1);
  assert.equal(postStateReads, 1);
  assert.equal(resultBuilds, 0);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, record.signature);
  t.diagnostic(`recovery getStatus=${statusReads}; finalized=${finalizedReads}; postState=${postStateReads}; observation=${observed.kind}`);
  assert.notEqual(observed.kind, "watchdog", "hung recovery preflight kept the reconciliation promise pending past its deadline");
});

test("S05: aged token journal cannot clear an unresolved wallet write fence", async (t) => {
  const storage = memoryStorage();
  const record = pendingRecord(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  storage.setItem(PENDING_TOKEN_OPERATION_STORAGE_KEY, JSON.stringify([record]));
  const key = `${networkStorageKey("thru.writeFence", 1)}.${walletAddress}`;
  const fence = JSON.stringify({ network: THRU_NETWORK.storageScope, wallet: walletAddress, signature });
  storage.setItem(key, fence);
  assert.deepEqual(loadPendingTokenOperations(storage), []);
  let statusReads = 0;
  let nextWrites = 0;
  t.mock.method(thru.transactions, "getStatus", async () => {
    statusReads += 1;
    throw new Error("transaction not found");
  });
  // Unit lock adapter only: actual Chromium Web Locks are tested separately.
  const locks: WriteLockProvider = { request: async (_name, _options, work) => work({}) };
  await assert.rejects(withWalletWriteGuard(walletAddress, async () => {
    nextWrites += 1;
  }, { locks, storage }), WriteOperationBlockedError);
  assert.equal(statusReads, 1);
  assert.equal(nextWrites, 0);
  assert.equal(storage.getItem(key), fence);
  assert.equal(storage.getItem(PENDING_TOKEN_OPERATION_STORAGE_KEY), JSON.stringify([record]));
});

test("S05: authoritative execution failure overrides conflicting success-shaped post-state", async () => {
  let postStateReads = 0;
  const result = await verifySubmittedTransaction({
    signature,
    readFinalizedTransaction: async () => ({
      getSignature: () => Signature.from(signatureBytes),
      executionResult: { vmError: 17, userErrorCode: 4n, executionResult: 1n },
    }),
    verifyExpectedState: async () => { postStateReads += 1; return true; },
  });
  assert.deepEqual(result, { outcome: "failure", source: "finalized-transaction" });
  assert.equal(postStateReads, 0);
});

test("S05: malformed signature evidence fails closed without status-based success or re-send", async () => {
  let sends = 0;
  let polls = 0;
  await assert.rejects(submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([5]),
    expectedSignature: signature,
    send: async () => { sends += 1; return signature; },
    getStatus: async () => {
      polls += 1;
      return { signature: new Uint8Array(3), statusCode: ConsensusStatus.FINALIZED, executionResult: successfulExecution };
    },
  }), (error: unknown) => {
    assert.ok(error instanceof SubmittedTransactionUncertainError);
    assert.equal(error.signature, signature);
    return true;
  });
  assert.equal(sends, 1);
  assert.equal(polls, 1);
});

test("S05: malformed execution fields must remain uncertain rather than authorize definitive failure", async () => {
  let sends = 0;
  const result = await submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([6]),
    expectedSignature: signature,
    send: async () => { sends += 1; return signature; },
    getStatus: async () => ({
      signature: signatureBytes,
      statusCode: ConsensusStatus.CLUSTER_EXECUTED,
      executionResult: { vmError: Number.NaN, userErrorCode: 0n, executionResult: 0n },
    }),
  });
  assert.equal(sends, 1);
  assert.equal(result.signature, signature);
  assert.equal(result.finalized, false);
  assert.equal(result.failure, undefined, "NaN is malformed evidence, not a definitive VM execution error");
});

test("Phase 5C-R: a stalled finalized lookup is bounded and cannot reach post-state or submission", async () => {
  let reads = 0, stateReads = 0;
  const observed = await observeWithin(verifySubmittedTransaction({
    signature, timeoutMs: 5,
    readFinalizedTransaction: () => { reads++; return new Promise(() => {}); },
    verifyExpectedState: async () => { stateReads++; return true; },
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") {
    assert.ok(observed.error instanceof SubmittedTransactionUncertainError);
    assert.equal(observed.error.signature, signature);
  }
  assert.equal(reads, 1); assert.equal(stateReads, 0);
});

for (const hungStage of ["status", "post-state"] as const) test(`Phase 5C-R: token visibility ${hungStage} await shares a bounded read-only budget`, async () => {
  let reads = 0, stateReads = 0;
  const observed = await observeWithin(waitForTransactionVisibility({
    signature, timeoutMs: 5,
    readStatus: () => {
      reads++;
      if (hungStage === "status") return new Promise<{ statusCode: ConsensusStatus }>(() => {});
      return Promise.resolve({ statusCode: ConsensusStatus.INCLUDED });
    },
    verifyExpectedState: () => { stateReads++; return new Promise(() => {}); },
    isFinalConsensus: (status) => status === ConsensusStatus.FINALIZED,
    assertExecutionSucceeded: () => true,
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") {
    assert.ok(observed.error instanceof TransactionStatusUncertainError);
    assert.equal(observed.error.signature, signature);
  }
  assert.equal(reads, 1); assert.equal(stateReads, hungStage === "status" ? 0 : 1);
});

test("Phase 5C-R: the initial recovery status read cannot hang before the bounded fallback", async (t) => {
  const storage = memoryStorage(); installStorage(t, storage);
  const record = pendingRecord(); savePendingTokenOperations(storage, [record]);
  let reads = 0, fallbackReads = 0, resultBuilds = 0;
  t.mock.method(thru.transactions, "getStatus", () => { reads++; return new Promise(() => {}); });
  t.mock.method(thru.transactions, "get", async () => { fallbackReads++; throw new Error("not found"); });
  const observed = await observeWithin(reconcilePendingOperation({
    base: { key: record.key, operationType: record.operationType, walletAddress, mintAddress,
      expectedPostState: record.expectedPostState }, timeoutMs: 5,
    verifyExpectedState: async () => true,
    buildResult: async () => { resultBuilds++; return true; },
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") {
    assert.ok(observed.error instanceof SubmittedTransactionUncertainError);
    assert.equal(observed.error.signature, record.signature);
  }
  assert.equal(reads, 1); assert.equal(fallbackReads, 0); assert.equal(resultBuilds, 0);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, record.signature);
});

test("Phase 5C-R: recovery result construction remains in the original verification budget", async (t) => {
  const storage = memoryStorage(); installStorage(t, storage);
  const record = pendingRecord(); savePendingTokenOperations(storage, [record]);
  t.mock.method(thru.transactions, "getStatus", async () => { throw new Error("not found"); });
  t.mock.method(thru.transactions, "get", async () => { throw new Error("not found"); });
  let builds = 0;
  const observed = await observeWithin(reconcilePendingOperation({
    base: { key: record.key, operationType: record.operationType, walletAddress, mintAddress,
      expectedPostState: record.expectedPostState }, timeoutMs: 5,
    verifyExpectedState: async () => true,
    buildResult: () => { builds++; return new Promise(() => {}); },
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") assert.ok(observed.error instanceof SubmittedTransactionUncertainError);
  assert.equal(builds, 1);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, record.signature);
});

test("Phase 5C-R: time consumed by unary send is not granted again to status polling", async () => {
  let clock = 0, sends = 0, polls = 0;
  const result = await submitSignedTransactionOnce({ rawTransaction: new Uint8Array([7]), expectedSignature: signature,
    timeoutMs: 10, pollIntervalMs: 5, now: () => clock,
    send: async () => { sends++; clock += 7; return signature; },
    getStatus: async () => { polls++; clock += 1; return { signature: signatureBytes, statusCode: ConsensusStatus.INCLUDED }; },
    sleep: async (delay) => { clock += delay; },
  });
  assert.equal(clock, 10); assert.equal(sends, 1); assert.equal(polls, 1);
  assert.equal(result.finalized, false); assert.equal(result.statusTimedOut, true);
  assert.equal(result.signature, signature);
});

function syntheticWire() {
  const transaction = new Transaction({ feePayer: walletAddress, program: mintAddress,
    header: { chainId: 2, startSlot: 100n, nonce: 1n, fee: 0n, expiryAfter: 100,
      computeUnits: 1, stateUnits: 0, memoryUnits: 1 }, instructionData: new Uint8Array([0]) });
  transaction.setSignature(Signature.from(signatureBytes));
  return transaction.toWire();
}

for (const lateStage of ["send-success", "send-rejection", "status-success"] as const) test(`Phase 5C-R: late ${lateStage} cannot change settled uncertainty or release journal/fence`, async () => {
  const storage = memoryStorage();
  const record = pendingRecord(); savePendingTokenOperations(storage, [record]);
  const locks: WriteLockProvider = { request: async (_name, _options, work) => work({}) };
  let release: (() => void) | undefined;
  let sends = 0, polls = 0;
  const result = await withWalletWriteGuard(walletAddress, async () => observeWithin(submitSignedTransactionOnce({
    rawTransaction: syntheticWire(), expectedSignature: signature, timeoutMs: 5,
    send: () => {
      sends++;
      if (lateStage === "status-success") return Promise.resolve(signature);
      return new Promise<string>((resolve, reject) => { release = () => lateStage === "send-rejection"
        ? reject(new Error("Synthetic delayed transport failure")) : resolve(signature); });
    },
    getStatus: () => { polls++; return new Promise((resolve) => { release = () => resolve({ signature: signatureBytes,
      statusCode: ConsensusStatus.FINALIZED, executionResult: successfulExecution }); }); },
  })), { locks, storage });
  assert.notEqual(result.kind, "watchdog");
  if (lateStage === "status-success") {
    assert.equal(result.kind, "returned");
    if (result.kind === "returned") assert.equal(result.value.finalized, false);
  } else {
    assert.equal(result.kind, "rejected");
    if (result.kind === "rejected") {
      assert.ok(result.error instanceof SubmittedTransactionUncertainError);
      assert.equal(result.error.signature, signature);
    }
  }
  const key = `${networkStorageKey("thru.writeFence", 1)}.${walletAddress}`;
  const fence = storage.getItem(key); assert.ok(fence?.includes(signature));
  release?.(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sends, 1); assert.equal(polls, lateStage === "status-success" ? 1 : 0);
  assert.equal(storage.getItem(key), fence);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, signature);
});

test("Phase 5C-R: deadline exhausted before unary invocation is not a submitted transaction", async () => {
  const storage = memoryStorage(); let clock = 0, sends = 0;
  const locks: WriteLockProvider = { request: async (_name, _options, work) => work({}) };
  await withWalletWriteGuard(walletAddress, async () => {
    await assert.rejects(submitSignedTransactionOnce({ rawTransaction: syntheticWire(), expectedSignature: signature,
      timeoutMs: 5, now: () => clock,
      onDiagnostic: (event) => { if (event.stage === "submit" && event.state === "started") clock = 6; },
      send: async () => { sends++; return signature; },
    }), (error: unknown) => error instanceof TransactionDeadlineExceededError && !(error instanceof SubmittedTransactionUncertainError));
  }, { locks, storage });
  assert.equal(sends, 0);
  assert.equal(storage.getItem(`${networkStorageKey("thru.writeFence", 1)}.${walletAddress}`), "null");
});

test("Phase 5C-R: completion and abort remove their deadline timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deadline = createTransactionDeadline(10, () => 0);
  assert.equal(await deadline.run(async () => 42), 42);
  t.mock.timers.tick(20);
  assert.equal(await deadline.run(async () => 43), 43, "a cleared timer must not expire an already completed await");
  const controller = new AbortController();
  const pending = deadline.run(() => new Promise(() => {}), controller.signal);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  t.mock.timers.tick(20);
  assert.equal(await deadline.run(async () => 44), 44);
});

const malformedExecutions: [string, unknown][] = [
  ["NaN", { ...successfulExecution, vmError: NaN }],
  ["Infinity", { ...successfulExecution, vmError: Infinity }],
  ["fractional VM code", { ...successfulExecution, vmError: 0.5 }],
  ["VM overflow", { ...successfulExecution, vmError: 0x8000_0000 }],
  ["VM underflow", { ...successfulExecution, vmError: -0x8000_0001 }],
  ["missing user code", { vmError: 0 }],
  ["number user code", { ...successfulExecution, userErrorCode: 0 }],
  ["negative user code", { ...successfulExecution, userErrorCode: -1n }],
  ["user code overflow", { ...successfulExecution, userErrorCode: 1n << 64n }],
  ["string execution result", { ...successfulExecution, executionResult: "0" }],
  ["negative execution result", { ...successfulExecution, executionResult: -1n }],
  ["execution result overflow", { ...successfulExecution, executionResult: 1n << 64n }],
  ["partial failure plus malformed field", { vmError: -255, userErrorCode: NaN }],
];
for (const [name, value] of malformedExecutions) test(`Phase 5C-R: malformed ${name} is unknown execution evidence`, () => {
  assert.equal(transactionExecutionOutcome(value), "unknown");
});

test("Phase 5C-R: valid negative SDK VM errors and optional legacy result remain compatible", async () => {
  assert.equal(transactionExecutionOutcome({ vmError: 0, userErrorCode: 0n }), "success");
  assert.equal(transactionExecutionOutcome(successfulExecution), "success");
  assert.equal(transactionExecutionOutcome({ ...successfulExecution, vmError: -255 }), "failure");
  const result = await submitSignedTransactionOnce({ rawTransaction: new Uint8Array([8]), expectedSignature: signature,
    send: async () => signature, getStatus: async () => ({ signature: signatureBytes,
      statusCode: ConsensusStatus.FINALIZED, executionResult: { ...successfulExecution, vmError: -255 } }),
  });
  assert.equal(result.finalized, false); assert.deepEqual(result.failure, { vmError: -255, userErrorCode: 0n });
});

test("Phase 5C-R: malformed finalized evidence cannot synthesize either verifier outcome", async () => {
  let clock = 0;
  await assert.rejects(verifySubmittedTransaction({ signature, timeoutMs: 10, initialBackoffMs: 10,
    readFinalizedTransaction: async () => ({ getSignature: () => Signature.from(signatureBytes),
      executionResult: { ...successfulExecution, vmError: NaN } }),
    verifyExpectedState: async () => false, now: () => clock, sleep: async (delay) => { clock += delay; },
  }), SubmittedTransactionUncertainError);
});

test("Phase 5C-R: authoritative visibility failure cannot fall through to conflicting post-state success", async () => {
  let stateReads = 0;
  await assert.rejects(waitForTransactionVisibility({ signature,
    readStatus: async () => ({ statusCode: ConsensusStatus.FINALIZED,
      executionResult: { ...successfulExecution, vmError: -255 } }),
    isFinalConsensus: (status) => status === ConsensusStatus.FINALIZED,
    assertExecutionSucceeded: () => false,
    verifyExpectedState: async () => { stateReads++; return true; },
  }), /Transaction execution failed/);
  assert.equal(stateReads, 0);
});

test("Phase 5C-R: late recovery reads cannot emit completed progress or mutate setup after uncertainty", async (t) => {
  const storage = memoryStorage(); installStorage(t, storage);
  const record = pendingRecord(); savePendingTokenOperations(storage, [record]);
  t.mock.method(thru.transactions, "getStatus", async () => { throw new Error("not found"); });
  t.mock.method(thru.transactions, "get", async () => { throw new Error("not found"); });
  let release: (() => void) | undefined, effects = 0;
  const observed = await observeWithin(reconcilePendingOperation({
    base: { key: record.key, operationType: record.operationType, walletAddress, mintAddress,
      expectedPostState: record.expectedPostState }, timeoutMs: 5,
    verifyExpectedState: async () => true,
    buildResult: async (_signature, _record, assertRecoveryActive) => {
      await new Promise<void>((resolve) => { release = resolve; });
      assertRecoveryActive();
      effects++;
      return true;
    },
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") assert.ok(observed.error instanceof TransactionStatusUncertainError);
  release?.(); await Promise.resolve(); await Promise.resolve();
  assert.equal(effects, 0);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, signature);
});

for (const evidence of ["missing", "malformed"] as const) test(`Phase 5C-R: ${evidence} final execution evidence cannot clear the actual durable fence`, async () => {
  const storage = memoryStorage(); let polls = 0;
  const locks: WriteLockProvider = { request: async (_name, _options, work) => work({}) };
  const result = await withWalletWriteGuard(walletAddress, () => submitSignedTransactionOnce({
    rawTransaction: syntheticWire(), expectedSignature: signature,
    send: async () => signature,
    sleep: async () => {},
    getStatus: async () => ++polls === 1
      ? { signature: signatureBytes, statusCode: ConsensusStatus.INCLUDED, executionResult: successfulExecution }
      : { signature: signatureBytes, statusCode: ConsensusStatus.FINALIZED,
        ...(evidence === "malformed" ? { executionResult: { ...successfulExecution, vmError: NaN } } : {}) },
  }), { locks, storage });
  assert.equal(result.finalized, false); assert.equal(result.executionSucceeded, false);
  assert.equal(result.failure, undefined); assert.equal(polls, 2);
  assert.ok(storage.getItem(`${networkStorageKey("thru.writeFence", 1)}.${walletAddress}`)?.includes(signature));
});

test("Phase 5C-R: authoritative recovery still bounds its exact readable account-match await", async (t) => {
  const storage = memoryStorage(); installStorage(t, storage);
  const record = { ...pendingRecord(), sourceTokenAccount: publicAddress(194), destinationTokenAccount: publicAddress(195) };
  savePendingTokenOperations(storage, [record]);
  t.mock.method(thru.transactions, "getStatus", async () => ({ signature: signatureBytes,
    statusCode: ConsensusStatus.CLUSTER_EXECUTED, executionResult: successfulExecution }));
  let accountReads = 0, resultBuilds = 0;
  t.mock.method(thru.accounts, "get", () => { accountReads++; return new Promise(() => {}); });
  const observed = await observeWithin(reconcilePendingOperation({
    base: { key: record.key, operationType: record.operationType, walletAddress, mintAddress,
      expectedPostState: record.expectedPostState }, timeoutMs: 5,
    verifyExpectedState: async () => true,
    buildResult: async () => { resultBuilds++; return true; },
  }));
  assert.equal(observed.kind, "rejected");
  if (observed.kind === "rejected") assert.ok(observed.error instanceof SubmittedTransactionUncertainError);
  assert.ok(accountReads > 0); assert.equal(resultBuilds, 0);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, signature);
});

test("Phase 5C-R: a frozen injected clock cannot restart the physical phase budget between awaits", async (t) => {
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const deadline = createTransactionDeadline(10, () => 0);
  assert.equal(await deadline.run(async () => { monotonic = 7; return true; }), true);
  await assert.rejects(deadline.run(async () => { monotonic = 11; return true; }), TransactionDeadlineExceededError);
  assert.equal(deadline.remainingMs(), 0);
});

for (const outcome of ["success", "failure"] as const) test(`S1: default finalized lookup verifies matching SDK identity before ${outcome} evidence`, async (t) => {
  const order: string[] = [];
  let reads = 0, stateReads = 0;
  t.mock.method(thru.transactions, "get", async (
    requested: Parameters<typeof thru.transactions.get>[0],
    options: Parameters<typeof thru.transactions.get>[1],
  ) => {
    reads++;
    assert.equal(requested, signature);
    assert.equal(options?.minConsensus, ConsensusStatus.FINALIZED);
    return {
      getSignature: () => { order.push("identity"); return Signature.from(signatureBytes); },
      get executionResult() {
        order.push("execution");
        return outcome === "success" ? successfulExecution : { ...successfulExecution, vmError: -255 };
      },
    };
  });
  const result = await verifySubmittedTransaction({ signature,
    verifyExpectedState: async () => { stateReads++; return true; },
  });
  assert.deepEqual(result, { outcome, source: "finalized-transaction" });
  assert.deepEqual(order, ["identity", "execution"]);
  assert.equal(reads, 1);
  assert.equal(stateReads, 0);
});

for (const evidence of ["success", "failure"] as const) test(`S1: default finalized lookup rejects mismatched identity before reading ${evidence} metadata`, async (t) => {
  let identityReads = 0, executionReads = 0, stateReads = 0;
  t.mock.method(thru.transactions, "get", async (
    requested: Parameters<typeof thru.transactions.get>[0],
    options: Parameters<typeof thru.transactions.get>[1],
  ) => {
    assert.equal(requested, signature);
    assert.equal(options?.minConsensus, ConsensusStatus.FINALIZED);
    return {
      getSignature: () => { identityReads++; return Signature.from(new Uint8Array(64).fill(190)); },
      get executionResult() {
        executionReads++;
        return evidence === "success" ? successfulExecution : { ...successfulExecution, vmError: -255 };
      },
    };
  });
  await assert.rejects(verifySubmittedTransaction({ signature,
    verifyExpectedState: async () => { stateReads++; return true; },
  }), (error: unknown) => {
    // Existing callers that catch the uncertain base contract must preserve the
    // original submitted signature rather than the untrusted response identity.
    assert.ok(error instanceof SubmittedTransactionIdentityError);
    assert.ok(error instanceof SubmittedTransactionUncertainError);
    assert.equal(error.signature, signature);
    assert.equal(error.message, SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
    return true;
  });
  assert.equal(identityReads, 1);
  assert.equal(executionReads, 0);
  assert.equal(stateReads, 0);
});

test("S1: default finalized lookup sanitizes a throwing SDK signature getter without post-state fallback", async (t) => {
  let executionReads = 0, stateReads = 0;
  t.mock.method(thru.transactions, "get", async () => ({
    getSignature: () => { throw new Error("Synthetic untrusted RPC internals"); },
    get executionResult() { executionReads++; return successfulExecution; },
  }));
  await assert.rejects(verifySubmittedTransaction({ signature,
    verifyExpectedState: async () => { stateReads++; return true; },
  }), (error: unknown) => {
    assert.ok(error instanceof SubmittedTransactionIdentityError);
    assert.equal(error.signature, signature);
    assert.equal(error.message, SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
    assert.equal(error.message.includes("RPC internals"), false);
    return true;
  });
  assert.equal(executionReads, 0);
  assert.equal(stateReads, 0);
});

test("S1 I13/I14: identity-conflicted token recovery retains its real journal and fence without rebuild, signing, or sending", async (t) => {
  const storage = memoryStorage();
  installStorage(t, storage);
  const record = pendingRecord();
  savePendingTokenOperations(storage, [record]);
  const fenceStorageKey = `${networkStorageKey("thru.writeFence", 1)}.${walletAddress}`;
  const fence = JSON.stringify({ network: THRU_NETWORK.storageScope, wallet: walletAddress, signature });
  storage.setItem(fenceStorageKey, fence);
  const locks: WriteLockProvider = { request: async (_name, _options, work) => work({}) };
  let statusReads = 0, finalizedReads = 0, identityReads = 0;
  let executionReads = 0, stateReads = 0, resultBuilds = 0;
  let transactionBuilds = 0, signs = 0, sends = 0, competingWrites = 0;
  t.mock.method(thru.transactions, "getStatus", async (
    requested: Parameters<typeof thru.transactions.getStatus>[0],
  ) => {
    statusReads++;
    assert.equal(requested, signature);
    throw new Error("Synthetic transaction not found");
  });
  t.mock.method(thru.transactions, "get", async (
    requested: Parameters<typeof thru.transactions.get>[0],
    options: Parameters<typeof thru.transactions.get>[1],
  ) => {
    finalizedReads++;
    assert.equal(requested, signature);
    assert.equal(options?.minConsensus, ConsensusStatus.FINALIZED);
    return {
      getSignature: () => { identityReads++; return Signature.from(new Uint8Array(64).fill(190)); },
      get executionResult() { executionReads++; return successfulExecution; },
    };
  });
  t.mock.method(thru.transactions, "build", () => { transactionBuilds++; throw new Error("Unexpected recovery build"); });
  t.mock.method(Transaction.prototype, "sign", () => { signs++; throw new Error("Unexpected recovery signing"); });
  t.mock.method(thru.transactions, "send", () => { sends++; throw new Error("Unexpected recovery send"); });
  t.mock.method(thru.transactions, "sendAndTrack", () => { sends++; throw new Error("Unexpected recovery streaming send"); });
  await assert.rejects(withWalletWriteGuard(walletAddress, () => reconcilePendingOperation({
    base: { key: record.key, operationType: record.operationType, walletAddress,
      mintAddress, expectedPostState: record.expectedPostState },
    verifyExpectedState: async () => { stateReads++; return true; },
    buildResult: async () => { resultBuilds++; return "must not construct success"; },
    timeoutMs: 100,
  }), { locks, storage, readOnlyRecovery: true }), (error: unknown) => {
    assert.ok(error instanceof TransactionStatusUncertainError);
    assert.equal(error.signature, signature);
    return true;
  });
  const [remaining] = loadPendingTokenOperations(storage);
  assert.equal(remaining?.key, record.key);
  assert.equal(remaining?.signature, signature);
  assert.equal(remaining?.status, "uncertain");
  assert.deepEqual(remaining?.expectedPostState, record.expectedPostState);
  assert.equal(storage.getItem(fenceStorageKey), fence);
  assert.equal(statusReads, 1);
  assert.equal(finalizedReads, 1);
  assert.equal(identityReads, 1);
  assert.equal(executionReads, 0);
  assert.equal(stateReads, 0);
  assert.equal(resultBuilds, 0);

  // A later competing write is still blocked by the unchanged durable fence.
  await assert.rejects(withWalletWriteGuard(walletAddress, async () => {
    competingWrites++;
  }, { locks, storage }), WriteOperationBlockedError);
  assert.equal(competingWrites, 0);
  assert.equal(statusReads, 2);
  assert.equal(storage.getItem(fenceStorageKey), fence);
  assert.equal(loadPendingTokenOperations(storage)[0]?.signature, signature);
  assert.equal(transactionBuilds, 0);
  assert.equal(signs, 0);
  assert.equal(sends, 0);
});
