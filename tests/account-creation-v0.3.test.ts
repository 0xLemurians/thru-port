import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test, { type TestContext } from "node:test";
import {
  ConsensusStatus,
  Pubkey,
  Signature,
  Transaction,
  type Account,
} from "@thru/sdk";
import { ACCOUNT_CREATION_RESOURCES } from "@thru/programs/resources";
import {
  ensureAccountExists,
  thru,
  type ThruAccount,
} from "../lib/wallet/thru-wallet";
import {
  FAUCET_ACCOUNT_ADDRESS,
  FAUCET_PROGRAM_ADDRESS,
  FAUCET_WITHDRAW_LIMIT,
  FaucetUnavailableError,
  assertFaucetDeploymentAvailable,
  withdrawFromFaucet,
} from "../lib/wallet/faucet";
import {
  SAFE_FAUCET_ERROR_MESSAGE,
  SAFE_FAUCET_UNAVAILABLE_MESSAGE,
  SAFE_FAUCET_UNCERTAIN_MESSAGE,
} from "../lib/wallet/faucet-safety";
import {
  SubmittedTransactionUncertainError,
  TransactionDeadlineExceededError,
} from "../lib/thru/transactions";
import { networkStorageKey, THRU_NETWORK } from "../lib/thru/network";
import {
  WriteOperationBlockedError,
  type WriteLockProvider,
} from "../lib/thru/write-operation-guard";

function notFound(): Error & { code: number } {
  const error = new Error("Account not found") as Error & { code: number };
  error.code = 5;
  return error;
}

function account(byte: number): ThruAccount {
  return {
    address: `test-account-${byte}`,
    publicKey: new Uint8Array(32).fill(byte),
    privateKey: new Uint8Array(32).fill(byte + 64),
  };
}

function foundAccount(
  activeAccount: ThruAccount,
  consensusStatus: ConsensusStatus = ConsensusStatus.FINALIZED,
) {
  return {
    address: {
      toThruFmt: () => activeAccount.address,
    },
    consensusStatus,
  };
}

function faucetDeploymentAccount(address: string): Account | undefined {
  if (address === FAUCET_PROGRAM_ADDRESS) {
    return {
      address: Pubkey.from(address),
      consensusStatus: ConsensusStatus.INCLUDED,
      meta: {
        flags: { isDeleted: false, isProgram: true },
      },
    } as unknown as Account;
  }
  if (address === FAUCET_ACCOUNT_ADDRESS) {
    return {
      address: Pubkey.from(address),
      consensusStatus: ConsensusStatus.INCLUDED,
      meta: {
        flags: { isDeleted: false, isProgram: false },
        owner: Pubkey.from(FAUCET_PROGRAM_ADDRESS),
        balance: FAUCET_WITHDRAW_LIMIT,
      },
    } as unknown as Account;
  }
  return undefined;
}

function testSignature(byte: number) {
  return {
    toThruFmt: () => signatureText(byte),
  };
}

function signatureText(byte: number): string {
  return Signature.from(new Uint8Array(64).fill(byte)).toThruFmt();
}

function statusSnapshot(
  byte: number,
  consensusStatus: ConsensusStatus = ConsensusStatus.FINALIZED,
  executionResult = {
    vmError: 0,
    userErrorCode: 0n,
    executionResult: 0n,
  },
) {
  return {
    signature: new Uint8Array(64).fill(byte),
    statusCode: consensusStatus,
    executionResult,
  };
}

function controlledTransactionClock(t: TestContext) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { due: number; run: () => void }>();
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ) => {
    const timer = ++nextTimer;
    timers.set(timer, { due: now + delay, run: () => callback(...args) });
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((timer: unknown) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout);

  return {
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [timer, scheduled] of [...timers]) {
        if (scheduled.due <= now && timers.delete(timer)) scheduled.run();
      }
    },
    pendingTimers: () => timers.size,
  };
}

async function withoutBrowserWriteLocks(work: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try { await work(); }
  finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

type AccountSendOutcome = "success" | "async-reject" | "sync-throw" | "never-settles" | "response-lost";

function guardedAccountSubmissionFixture(
  t: TestContext,
  byte: number,
  outcome: AccountSendOutcome,
) {
  const clock = controlledTransactionClock(t);
  const publicKey = new Uint8Array(32).fill(byte);
  const activeAccount: ThruAccount = {
    address: Pubkey.from(publicKey).toThruFmt(),
    publicKey,
    privateKey: new Uint8Array(),
  };
  const signature = Signature.from(new Uint8Array(64).fill(byte));
  const stored = new Map<string, string>();
  const fenceKey = `${networkStorageKey("thru.writeFence", 1)}.${activeAccount.address}`;
  const counts = {
    accountReads: 0, builds: 0, signs: 0, sends: 0, statusReads: 0,
    finalizedReads: 0, reservations: 0, releases: 0, externalCalls: 0,
  };
  const state: {
    account: "missing" | "matching" | "wrong-wallet";
    afterSendAccount: "missing" | "matching" | "wrong-wallet";
    statusFinalized: boolean;
    finalizedAvailable: boolean;
    buildFailure?: Error;
  } = {
    account: "missing", afterSendAccount: "matching",
    statusFinalized: false, finalizedAvailable: false,
  };
  let markSendStarted: (() => void) | undefined;
  const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
  const denied = () => {
    counts.externalCalls++;
    throw new Error("Account submission fixtures forbid external transport");
  };
  t.mock.method(globalThis, "fetch", denied);
  for (const transport of [http, https]) {
    t.mock.method(transport, "request", denied);
    t.mock.method(transport, "get", denied);
  }
  t.mock.method(net.Socket.prototype, "connect", denied);

  // Node-only lock adapter: exercise the production guard and durable fence,
  // without claiming this replaces the separate actual-browser Web Locks QA.
  let locked = false;
  const locks: WriteLockProvider = { async request(_name, _options, work) {
    if (locked) return work(null);
    locked = true;
    try { return await work({}); } finally { locked = false; }
  } };
  const globals = {
    window: { localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
        if (key === fenceKey) {
          if (value === "null") counts.releases++; else counts.reservations++;
        }
      },
    } },
    document: {},
    navigator: { locks },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.after(() => {
    assert.equal(counts.externalCalls, 0);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(locked, false);
  });

  t.mock.method(thru.accounts, "get", async (address: string) => {
    counts.accountReads++;
    assert.equal(address, activeAccount.address);
    if (state.account === "missing") throw notFound();
    return foundAccount(state.account === "matching" ? activeAccount : account(byte + 1)) as never;
  });
  t.mock.method(thru.accounts, "create", async () => {
    counts.builds++;
    if (state.buildFailure) throw state.buildFailure;
    // Only a public SDK wire model is real; all signing and transport are fake.
    const transaction = new Transaction({
      feePayer: activeAccount.address,
      program: Pubkey.from(new Uint8Array(32).fill(230)),
      header: { chainId: THRU_NETWORK.expectedChainId, startSlot: 100n, nonce: 1n,
        fee: 0n, expiryAfter: 100, computeUnits: 1, stateUnits: 0, memoryUnits: 1 },
    });
    transaction.setSignature(signature);
    Object.defineProperty(transaction, "sign", { value: async (privateKey: Uint8Array) => {
      counts.signs++;
      assert.equal(privateKey.length, 0);
    } });
    return transaction;
  });
  t.mock.method(thru.transactions, "send", (raw: Uint8Array) => {
    counts.sends++;
    assert.equal(Transaction.fromWire(raw).getSignature()?.toThruFmt(), signature.toThruFmt());
    assert.equal(JSON.parse(stored.get(fenceKey)!).signature, signature.toThruFmt());
    assert.equal(counts.releases, 0, "the provisional fence must still exist at unary entry");
    markSendStarted?.();
    if (outcome === "sync-throw") throw new Error("SDK unary send threw synchronously");
    if (outcome === "never-settles") return new Promise<string>(() => {});
    if (outcome === "success" || outcome === "response-lost") state.account = state.afterSendAccount;
    if (outcome !== "success") return Promise.reject(new Error("Unary response unavailable"));
    return Promise.resolve(signature.toThruFmt());
  });
  t.mock.method(thru.transactions, "getStatus", async (requested: string) => {
    counts.statusReads++;
    assert.equal(requested, signature.toThruFmt());
    if (!state.statusFinalized) throw notFound();
    return statusSnapshot(byte) as never;
  });
  t.mock.method(thru.transactions, "get", async (requested: string, options: unknown) => {
    counts.finalizedReads++;
    assert.equal(requested, signature.toThruFmt());
    assert.deepEqual(options, { minConsensus: ConsensusStatus.FINALIZED });
    if (!state.finalizedAvailable) throw notFound();
    return { executionResult: { vmError: 0, userErrorCode: 0n, executionResult: 0n } } as never;
  });

  return {
    activeAccount, clock, counts, sendStarted, state,
    signature: signature.toThruFmt(),
    fence: () => stored.get(fenceKey) ?? null,
    isUncertain(error: unknown): boolean {
      assert.ok(error instanceof SubmittedTransactionUncertainError);
      assert.equal(error.signature, signature.toThruFmt());
      return true;
    },
  };
}

test("account creation uses the active wallet, official v0.4.1 resources, and one finalized submission", async (t) => {
  const activeAccount = account(11);
  let accountReads = 0;
  let createCalls = 0;
  let signCalls = 0;
  let sendCalls = 0;
  let capturedCreate:
    | {
        publicKey?: Uint8Array;
        header?: {
          computeUnits?: number;
          stateUnits?: number;
          memoryUnits?: number;
        };
      }
    | undefined;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.accounts, "create", async (options: {
    publicKey: Uint8Array;
    header?: {
      computeUnits?: number;
      stateUnits?: number;
      memoryUnits?: number;
    };
  }) => {
    createCalls += 1;
    capturedCreate = options;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 500n,
      sign: async (privateKey: Uint8Array) => {
        signCalls += 1;
        assert.deepEqual(privateKey, activeAccount.privateKey);
      },
      getSignature: () => testSignature(11),
      toWire: () => new Uint8Array([3, 0, 3]),
    } as never;
  });
  t.mock.method(
    thru.transactions,
    "send",
    async (wire: Uint8Array) => {
      sendCalls += 1;
      assert.deepEqual(wire, new Uint8Array([3, 0, 3]));
      return signatureText(11);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(11) as never,
  );

  assert.equal(await ensureAccountExists(activeAccount), true);
  assert.equal(createCalls, 1);
  assert.equal(signCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(accountReads, 2);
  assert.deepEqual(capturedCreate?.publicKey, activeAccount.publicKey);
  assert.deepEqual(capturedCreate?.header, ACCOUNT_CREATION_RESOURCES);
});

test("account creation requires post-state account existence after finalized execution", async (t) => {
  const activeAccount = account(12);
  let accountReads = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    throw new Error("Post-state read failed");
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 501n,
    sign: async () => undefined,
    getSignature: () => testSignature(12),
    toWire: () => new Uint8Array([3, 0, 4]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => signatureText(12),
  );
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(12) as never,
  );

  await assert.rejects(
    () => ensureAccountExists(activeAccount),
    /post-state read failed/i,
  );
  assert.equal(accountReads, 2);
});

test("authoritative account-create execution accepts the matching INCLUDED point read", async (t) => {
  const activeAccount = account(112);
  let accountReads = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(
      activeAccount,
      ConsensusStatus.INCLUDED,
    ) as never;
  });
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 511n,
    sign: async () => undefined,
    getSignature: () => testSignature(112),
    toWire: () => new Uint8Array([3, 1, 12]),
  }) as never);
  t.mock.method(thru.transactions, "send", async () => {
    sendCalls += 1;
    return signatureText(112);
  });
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(112, ConsensusStatus.CLUSTER_EXECUTED) as never,
  );

  assert.equal(await ensureAccountExists(activeAccount), true);
  assert.equal(accountReads, 2);
  assert.equal(sendCalls, 1);
});

test("a finalized read-only lookup resolves status polling that ends before finality", async (t) => {
  // This neighboring 1ms case also failed before unary entry under the bounded
  // deadline. Advance only after the intended status observation has started.
  const clock = controlledTransactionClock(t);
  const activeAccount = account(15);
  let accountReads = 0;
  let sendCalls = 0;
  let finalizedReads = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 504n,
    sign: async () => undefined,
    getSignature: () => testSignature(15),
    toWire: () => new Uint8Array([3, 0, 7]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(15);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    clock.advance(1);
    throw new Error("Status not found yet");
  });
  t.mock.method(thru.transactions, "get", async (signature: string) => {
    finalizedReads += 1;
    assert.equal(signature, signatureText(15));
    return {
      executionResult: {
        vmError: 0,
        userErrorCode: 0n,
        executionResult: 0n,
      },
    } as never;
  });

  assert.equal(
    await ensureAccountExists(activeAccount, { timeoutMs: 1 }),
    true,
  );
  assert.equal(sendCalls, 1);
  assert.equal(finalizedReads, 1);
  assert.equal(accountReads, 2);
});

test("exact finalized account post-state resolves unavailable signature lookup", async (t) => {
  const activeAccount = account(16);
  let accountReads = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 505n,
    sign: async () => undefined,
    getSignature: () => testSignature(16),
    toWire: () => new Uint8Array([3, 0, 8]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(16);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw new Error("Status unavailable");
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("Finalized transaction lookup unavailable");
  });

  assert.equal(
    await ensureAccountExists(activeAccount, { timeoutMs: 1 }),
    true,
  );
  assert.equal(sendCalls, 1);
  assert.equal(accountReads, 3);
});

test("an uncertain submitted account creation cannot be rebroadcast automatically", async (t) => {
  const activeAccount = account(13);
  let createCalls = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async () => {
    throw notFound();
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => {
    createCalls += 1;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 502n,
      sign: async () => undefined,
      getSignature: () => testSignature(13),
      toWire: () => new Uint8Array([3, 0, 5]),
    } as never;
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(13);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw notFound();
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw notFound();
  });

  await assert.rejects(
    () =>
      ensureAccountExists(activeAccount, {
        timeoutMs: 1,
        verificationTimeoutMs: 1,
      }),
    (error) =>
      error instanceof SubmittedTransactionUncertainError &&
      error.signature === signatureText(13),
  );
  await assert.rejects(
    () => ensureAccountExists(activeAccount),
    (error) =>
      error instanceof SubmittedTransactionUncertainError &&
      error.signature === signatureText(13),
  );
  assert.equal(createCalls, 1);
  assert.equal(sendCalls, 1);
});

test("an unavailable account status endpoint falls back without rebroadcasting", async (t) => {
  // Keep the 1ms budget, but expire it only after the mocked unary send and
  // first status read have begun. No real scheduler latency controls coverage.
  const clock = controlledTransactionClock(t);
  const activeAccount = account(19);
  let accountReads = 0;
  let sendCalls = 0;
  let finalizedReads = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 509n,
    sign: async () => undefined,
    getSignature: () => testSignature(19),
    toWire: () => new Uint8Array([3, 0, 12]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(19);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    clock.advance(1);
    throw new Error("upstream status temporarily unavailable");
  });
  t.mock.method(thru.transactions, "get", async () => {
    finalizedReads += 1;
    return {
      executionResult: {
        vmError: 0,
        userErrorCode: 0n,
        executionResult: 0n,
      },
    } as never;
  });

  assert.equal(
    await ensureAccountExists(activeAccount, { timeoutMs: 1 }),
    true,
  );
  assert.equal(sendCalls, 1);
  assert.equal(finalizedReads, 1);
  assert.equal(accountReads, 2);
});

test("pre-unary expiry releases each provisional fence and clears active account creation before an explicit retry", async (t) => {
  const fixture = guardedAccountSubmissionFixture(t, 217, "success");
  const options = {
    timeoutMs: 1,
    onDiagnostic: (event: { stage: string; state: string }) => {
      if (event.stage === "account-create-submit" && event.state === "started") fixture.clock.advance(2);
    },
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(ensureAccountExists(fixture.activeAccount, options), (error: unknown) => {
      assert.ok(error instanceof TransactionDeadlineExceededError);
      assert.equal(error instanceof SubmittedTransactionUncertainError, false);
      return true;
    });
    assert.equal(fixture.counts.builds, attempt);
    assert.equal(fixture.counts.signs, attempt);
    assert.equal(fixture.counts.reservations, attempt);
    assert.equal(fixture.counts.releases, attempt);
    assert.equal(fixture.fence(), "null");
  }
  assert.equal(fixture.counts.sends, 0);
  assert.equal(fixture.counts.statusReads, 0);
  assert.equal(fixture.counts.finalizedReads, 0);
});

for (const [outcome, byte, description] of [
  ["async-reject", 218, "an asynchronously rejected unary account send"],
  ["sync-throw", 219, "a synchronously throwing unary account send"],
  ["never-settles", 220, "a unary account send whose Promise never settles"],
  ["response-lost", 221, "an accepted account send whose response is lost"],
] as const) {
  test(`${description} preserves the original signature, uncertainty, and write fence without rebroadcast`, async (t) => {
    const fixture = guardedAccountSubmissionFixture(t, byte, outcome);
    const pending = ensureAccountExists(fixture.activeAccount, { timeoutMs: 1 });
    const rejected = assert.rejects(pending, fixture.isUncertain);
    await fixture.sendStarted;
    if (outcome === "never-settles") fixture.clock.advance(1);
    await rejected;

    assert.equal(fixture.counts.sends, 1);
    assert.equal(fixture.counts.builds, 1);
    assert.equal(fixture.counts.signs, 1);
    assert.equal(fixture.counts.statusReads, 0);
    assert.equal(fixture.counts.finalizedReads, 0);
    assert.equal(fixture.counts.reservations, 1);
    assert.equal(fixture.counts.releases, 0);
    const retainedFence = fixture.fence();
    assert.equal(JSON.parse(retainedFence!).signature, fixture.signature);

    // A later explicit call may only read the unresolved fence, not rebuild or
    // resend. A lost response remains fenced even if the account is visible.
    await assert.rejects(ensureAccountExists(fixture.activeAccount), WriteOperationBlockedError);
    assert.equal(fixture.counts.accountReads, 1);
    assert.equal(fixture.counts.statusReads, 1);
    assert.equal(fixture.fence(), retainedFence);
    assert.equal(fixture.counts.releases, 0);
    assert.equal(fixture.counts.sends, 1);
    assert.equal(fixture.counts.builds, 1);

    // Also exercise the caller's retained UNCERTAIN map on platforms without
    // Web Locks; the durable fence must not be the only rebroadcast defense.
    fixture.state.account = "missing";
    await withoutBrowserWriteLocks(async () => {
      await assert.rejects(ensureAccountExists(fixture.activeAccount), fixture.isUncertain);
    });
    assert.equal(fixture.fence(), retainedFence);
    assert.equal(fixture.counts.releases, 0);
    assert.equal(fixture.counts.builds, 1);
    assert.equal(fixture.counts.sends, 1);

    // Only new authoritative read-only evidence permits resolution; neither
    // obtaining that evidence nor observing the exact account sends anything.
    fixture.state.statusFinalized = true;
    fixture.state.account = "matching";
    assert.equal(await ensureAccountExists(fixture.activeAccount), false);
    assert.equal(fixture.fence(), "null");
    assert.equal(fixture.counts.sends, 1);
    assert.equal(fixture.counts.finalizedReads, 0);

    // Probe a separate pre-send build after resolution. Reaching the builder
    // proves no ACTIVE entry survived; a sentinel prevents any new signing/send.
    fixture.state.account = "missing";
    const buildProbe = new Error("Explicit pre-send lifecycle probe");
    fixture.state.buildFailure = buildProbe;
    await assert.rejects(ensureAccountExists(fixture.activeAccount), (error: unknown) => error === buildProbe);
    assert.equal(fixture.counts.builds, 2);
    assert.equal(fixture.counts.signs, 1);
    assert.equal(fixture.counts.sends, 1);
  });
}

test("a successful guarded account send releases its fence only after authoritative finalization", async (t) => {
  const fixture = guardedAccountSubmissionFixture(t, 222, "success");
  fixture.state.statusFinalized = true;

  assert.equal(await ensureAccountExists(fixture.activeAccount, { timeoutMs: 1 }), true);
  assert.equal(fixture.counts.sends, 1);
  assert.equal(fixture.counts.statusReads, 1);
  assert.equal(fixture.counts.finalizedReads, 0);
  assert.equal(fixture.counts.accountReads, 2);
  assert.equal(fixture.counts.reservations, 1);
  assert.equal(fixture.fence(), "null");
});

test("read-only account finalization cannot turn a different wallet post-state into success", async (t) => {
  const fixture = guardedAccountSubmissionFixture(t, 223, "success");
  fixture.state.afterSendAccount = "wrong-wallet";
  fixture.state.finalizedAvailable = true;
  t.mock.method(thru.transactions, "getStatus", async (requested: string) => {
    fixture.counts.statusReads++;
    assert.equal(requested, fixture.signature);
    fixture.clock.advance(1);
    throw new Error("Status endpoint unavailable");
  });

  await assert.rejects(
    ensureAccountExists(fixture.activeAccount, { timeoutMs: 1 }),
    /finalized account does not match the active wallet/i,
  );
  assert.equal(fixture.counts.sends, 1);
  assert.equal(fixture.counts.statusReads, 1);
  assert.equal(fixture.counts.finalizedReads, 1);
  assert.equal(fixture.counts.accountReads, 2);
  assert.equal(fixture.counts.releases, 0);
  assert.equal(JSON.parse(fixture.fence()!).signature, fixture.signature);

  // Isolate the retained caller classification without clearing the fence:
  // platforms without Web Locks still must not automatically rebuild or send.
  await withoutBrowserWriteLocks(async () => {
    fixture.state.account = "missing";
    await assert.rejects(ensureAccountExists(fixture.activeAccount), fixture.isUncertain);
  });
  assert.equal(fixture.counts.builds, 1);
  assert.equal(fixture.counts.sends, 1);
});

test("concurrent account creation calls cannot submit twice", async (t) => {
  const activeAccount = account(14);
  let accountReads = 0;
  let releaseCreate: (() => void) | undefined;
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const pendingCreate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads <= 2) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.accounts, "create", async () => {
    markCreateStarted?.();
    await pendingCreate;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 503n,
      sign: async () => undefined,
      getSignature: () => testSignature(14),
      toWire: () => new Uint8Array([3, 0, 6]),
    } as never;
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(14);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(14) as never,
  );

  const first = ensureAccountExists(activeAccount);
  await createStarted;
  await assert.rejects(
    () => ensureAccountExists(activeAccount),
    /already in progress/i,
  );
  releaseCreate?.();
  assert.equal(await first, true);
  assert.equal(sendCalls, 1);
});

test("a missing derived faucet vault produces a safe unavailable error", async () => {
  await assert.rejects(
    () =>
      assertFaucetDeploymentAvailable(async (address) => {
        if (address === FAUCET_PROGRAM_ADDRESS) {
          return faucetDeploymentAccount(address)!;
        }
        throw notFound();
      }),
    (error: unknown) => {
      assert.ok(error instanceof FaucetUnavailableError);
      assert.equal(error.message, SAFE_FAUCET_UNAVAILABLE_MESSAGE);
      return true;
    },
  );
});

test("an invalid faucet vault owner prevents transaction preparation", async (t) => {
  const activeAccount = account(46);
  let createCalls = 0;
  let buildCalls = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    if (address === FAUCET_PROGRAM_ADDRESS) {
      return faucetDeploymentAccount(address);
    }
    if (address === FAUCET_ACCOUNT_ADDRESS) {
      return {
        ...faucetDeploymentAccount(address)!,
        meta: {
          flags: { isDeleted: false, isProgram: false },
          owner: Pubkey.from(new Uint8Array(32).fill(99)),
        },
      } as never;
    }
    throw new Error("wallet reads must not start for an unavailable faucet");
  });
  t.mock.method(thru.accounts, "create", async () => {
    createCalls += 1;
    throw new Error("account creation must not start");
  });
  t.mock.method(thru.transactions, "build", async () => {
    buildCalls += 1;
    throw new Error("faucet transaction must not be built");
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(46);
    },
  );

  const result = await withdrawFromFaucet(activeAccount);
  assert.deepEqual(result, {
    signature: "",
    finalized: false,
    failureReason: SAFE_FAUCET_UNAVAILABLE_MESSAGE,
    attempts: 0,
  });
  assert.equal(createCalls, 0);
  assert.equal(buildCalls, 0);
  assert.equal(sendCalls, 0);
});

test("faucet funding proceeds only after fallback-verified account creation", async (t) => {
  // Repeated execution exposed this nested account-create 1ms deadline too.
  // End its first status phase deterministically; leave the faucet phase fresh.
  const clock = controlledTransactionClock(t);
  const activeAccount = account(17);
  let accountReads = 0;
  let accountCreateCalls = 0;
  let faucetBuildCalls = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    const deployment = faucetDeploymentAccount(address);
    if (deployment) return deployment;
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return {
      ...foundAccount(activeAccount),
      meta: { balance: FAUCET_WITHDRAW_LIMIT },
    } as never;
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => {
    accountCreateCalls += 1;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 506n,
      sign: async () => undefined,
      getSignature: () => testSignature(17),
      toWire: () => new Uint8Array([3, 0, 9]),
    } as never;
  });
  t.mock.method(thru.transactions, "build", async () => {
    faucetBuildCalls += 1;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 507n,
      sign: async () => undefined,
      getSignature: () => ({
        toThruFmt: () => signatureText(117),
      }),
      toWire: () => new Uint8Array([3, 0, 10]),
    } as never;
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("Finalized transaction lookup unavailable");
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return sendCalls === 1 ? signatureText(17) : signatureText(117);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    if (sendCalls === 1) {
      clock.advance(1);
      throw new Error("Account status not available yet");
    }
    return statusSnapshot(117) as never;
  });

  const result = await withdrawFromFaucet(
    activeAccount,
    FAUCET_WITHDRAW_LIMIT,
    { timeoutMs: 1 },
  );
  assert.equal(result.failureReason, undefined);
  assert.equal(result.signature, signatureText(117));
  assert.equal(result.attempts, 1);
  assert.equal(accountCreateCalls, 1);
  assert.equal(faucetBuildCalls, 1);
  assert.equal(sendCalls, 2);
});

test("faucet funding uses read-only fallback after status polling times out", async (t) => {
  const activeAccount = account(20);
  let accountReads = 0;
  let faucetBuildCalls = 0;
  let sendCalls = 0;
  let finalizedReads = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    const deployment = faucetDeploymentAccount(address);
    if (deployment) return deployment;
    accountReads += 1;
    return {
      ...foundAccount(activeAccount),
      meta: {
        balance: accountReads >= 3 ? FAUCET_WITHDRAW_LIMIT : 0n,
      },
    } as never;
  });
  t.mock.method(thru.transactions, "build", async () => {
    faucetBuildCalls += 1;
    return {
      chainId: THRU_NETWORK.expectedChainId,
      startSlot: 510n,
      sign: async () => undefined,
      getSignature: () => ({
        toThruFmt: () => signatureText(120),
      }),
      toWire: () => new Uint8Array([3, 0, 13]),
    } as never;
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(120);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw new Error("Status stream replacement still catching up");
  });
  t.mock.method(thru.transactions, "get", async () => {
    finalizedReads += 1;
    return {
      executionResult: {
        vmError: 0,
        userErrorCode: 0n,
        executionResult: 0n,
      },
    } as never;
  });

  const result = await withdrawFromFaucet(
    activeAccount,
    FAUCET_WITHDRAW_LIMIT,
    { timeoutMs: 1 },
  );
  assert.equal(result.failureReason, undefined);
  assert.equal(result.signature, signatureText(120));
  assert.equal(result.finalized, true);
  assert.equal(result.attempts, 1);
  assert.equal(faucetBuildCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(finalizedReads, 1);
});

test("faucet funding does not start while account creation remains uncertain", async (t) => {
  const activeAccount = account(18);
  let faucetBuildCalls = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    const deployment = faucetDeploymentAccount(address);
    if (deployment) return deployment;
    throw notFound();
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 508n,
    sign: async () => undefined,
    getSignature: () => testSignature(18),
    toWire: () => new Uint8Array([3, 0, 11]),
  }) as never);
  t.mock.method(thru.transactions, "build", async () => {
    faucetBuildCalls += 1;
    throw new Error("Faucet build must not run");
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw notFound();
  });
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(18);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw notFound();
  });

  const result = await withdrawFromFaucet(
    activeAccount,
    FAUCET_WITHDRAW_LIMIT,
    { timeoutMs: 1 },
  );
  assert.equal(result.failureReason, SAFE_FAUCET_UNCERTAIN_MESSAGE);
  assert.equal(result.signature, signatureText(18));
  assert.equal(result.attempts, 0);
  assert.equal(faucetBuildCalls, 0);
  assert.equal(sendCalls, 1);
});

test("abort after account-create submission reconciles without rebroadcast", async (t) => {
  const activeAccount = account(41);
  const controller = new AbortController();
  let accountReads = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async () => {
    accountReads += 1;
    if (accountReads === 1) throw notFound();
    return foundAccount(activeAccount) as never;
  });
  t.mock.method(thru.chain, "getChainId", async () => THRU_NETWORK.expectedChainId);
  t.mock.method(thru.accounts, "create", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 900n,
    sign: async () => undefined,
    getSignature: () => testSignature(41),
    toWire: () => new Uint8Array([4, 1]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      controller.abort();
      return signatureText(41);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(41) as never,
  );
  t.mock.method(thru.transactions, "get", async () => ({
    executionResult: {
      vmError: 0,
      userErrorCode: 0n,
      executionResult: 0n,
    },
  }) as never);

  assert.equal(
    await ensureAccountExists(activeAccount, { signal: controller.signal }),
    true,
  );
  assert.equal(sendCalls, 1);
});

test("unrelated balance movement cannot override a finalized faucet failure", async (t) => {
  const activeAccount = account(42);
  let accountReads = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    const deployment = faucetDeploymentAccount(address);
    if (deployment) return deployment;
    accountReads += 1;
    return {
      ...foundAccount(activeAccount),
      meta: {
        balance:
          accountReads >= 3 ? FAUCET_WITHDRAW_LIMIT : 0n,
      },
    } as never;
  });
  t.mock.method(thru.transactions, "build", async () => ({
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 901n,
    sign: async () => undefined,
    getSignature: () => testSignature(142),
    toWire: () => new Uint8Array([4, 2]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "send",
    async () => {
      sendCalls += 1;
      return signatureText(142);
    },
  );
  t.mock.method(thru.transactions, "getStatus", async () =>
    statusSnapshot(142, ConsensusStatus.INCLUDED, {
      vmError: 1,
      userErrorCode: 0n,
      executionResult: 0n,
    }) as never,
  );
  t.mock.method(thru.transactions, "get", async () => ({
    executionResult: {
      vmError: 1,
      userErrorCode: 0n,
      executionResult: 0n,
    },
  }) as never);

  const result = await withdrawFromFaucet(activeAccount);
  assert.equal(result.failureReason, SAFE_FAUCET_ERROR_MESSAGE);
  assert.equal(result.signature, signatureText(142));
  assert.equal(sendCalls, 1);
});

test("a proven pre-unary account deadline must not later claim an unsent transaction was submitted", async (t) => {
  // Public shape fixtures only: signing is replaced, no private key is used,
  // and every external transport boundary below is denied.
  const publicKey = new Uint8Array(32).fill(216);
  const activeAccount: ThruAccount = {
    address: Pubkey.from(publicKey).toThruFmt(),
    publicKey,
    privateKey: new Uint8Array(),
  };
  const originalSignature = Signature.from(new Uint8Array(64).fill(216));
  const stored = new Map<string, string>();
  let clock = 0;
  let sendCalls = 0, statusReads = 0, finalizedReads = 0;
  let fenceReservations = 0, fenceReleases = 0, unexpectedExternalCalls = 0;
  const denied = () => {
    unexpectedExternalCalls++;
    throw new Error("Account deadline regression forbids external transport");
  };
  t.mock.method(globalThis, "fetch", denied);
  for (const transport of [http, https]) {
    t.mock.method(transport, "request", denied);
    t.mock.method(transport, "get", denied);
  }
  t.mock.method(net.Socket.prototype, "connect", denied);
  t.mock.method(Date, "now", () => clock);
  t.mock.method(performance, "now", () => clock);

  // This Node lock adapter exercises the real guard/fence implementation; it
  // is not a substitute for the separate actual Chromium Web Locks evidence.
  const globals = {
    window: { localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
        if (key.startsWith("thru.writeFence")) {
          if (value === "null") fenceReleases++; else fenceReservations++;
        }
      },
    } },
    document: {},
    navigator: { locks: { request: async (
      _name: string, _options: object, work: (lock: object) => Promise<unknown>,
    ) => work({}) } },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  t.after(() => assert.equal(unexpectedExternalCalls, 0));

  t.mock.method(thru.accounts, "get", async () => { throw notFound(); });
  t.mock.method(thru.accounts, "create", async () => {
    const transaction = new Transaction({
      feePayer: activeAccount.address,
      program: Pubkey.from(new Uint8Array(32).fill(220)),
      header: { chainId: THRU_NETWORK.expectedChainId, startSlot: 100n, nonce: 1n,
        fee: 0n, expiryAfter: 100, computeUnits: 1, stateUnits: 0, memoryUnits: 1 },
    });
    transaction.setSignature(originalSignature);
    Object.defineProperty(transaction, "sign", { value: async () => undefined });
    return transaction;
  });
  t.mock.method(thru.transactions, "send", async () => {
    sendCalls++;
    throw new Error("The pre-unary deadline must prevent this mocked send");
  });
  t.mock.method(thru.transactions, "getStatus", async () => { statusReads++; throw notFound(); });
  t.mock.method(thru.transactions, "get", async () => { finalizedReads++; throw notFound(); });
  const options = {
    timeoutMs: 1,
    onDiagnostic: (event: { stage: string; state: string }) => {
      // Deliberately expire AFTER reservation, but BEFORE actual unary entry.
      if (event.stage === "account-create-submit" && event.state === "started") clock += 2;
    },
  };
  await assert.rejects(ensureAccountExists(activeAccount, options), (error: unknown) =>
    error instanceof TransactionDeadlineExceededError && !(error instanceof SubmittedTransactionUncertainError));
  assert.equal(sendCalls, 0);
  assert.equal(statusReads, 0);
  assert.equal(finalizedReads, 0);
  assert.equal(fenceReservations, 1);
  assert.equal(fenceReleases, 1);
  assert.equal([...stored.values()].some((value) => value !== "null"), false);

  // A separate explicit call probes retained caller state. The same boundary
  // prevents ALL sends; this is not an automatic transaction retry.
  let nextError: unknown;
  try { await ensureAccountExists(activeAccount, options); }
  catch (error) { nextError = error; }
  assert.equal(sendCalls, 0);
  assert.equal(nextError instanceof SubmittedTransactionUncertainError, false,
    "an unsent signature must not become a misleading submitted claim on the next explicit call");
});
