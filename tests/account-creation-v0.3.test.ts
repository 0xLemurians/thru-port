import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsensusStatus,
  Pubkey,
  SubmissionStatus,
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
import { SubmittedTransactionUncertainError } from "../lib/thru/transactions";
import { THRU_NETWORK } from "../lib/thru/network";

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

function foundAccount(activeAccount: ThruAccount) {
  return {
    address: {
      toThruFmt: () => activeAccount.address,
    },
    consensusStatus: ConsensusStatus.FINALIZED,
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
    toThruFmt: () => `test-signature-${byte}`,
  };
}

function successfulUpdate(
  consensusStatus: ConsensusStatus = ConsensusStatus.FINALIZED,
) {
  return {
    status: SubmissionStatus.ACCEPTED,
    consensusStatus,
    executionResult: {
      vmError: 0,
      userErrorCode: 0n,
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
    "sendAndTrack",
    async function* (wire: Uint8Array) {
      sendCalls += 1;
      assert.deepEqual(wire, new Uint8Array([3, 0, 3]));
      yield successfulUpdate() as never;
    },
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
    "sendAndTrack",
    async function* () {
      yield successfulUpdate() as never;
    },
  );

  await assert.rejects(
    () => ensureAccountExists(activeAccount),
    /post-state read failed/i,
  );
  assert.equal(accountReads, 2);
});

test("a finalized read-only lookup resolves a stream that ends after execution", async (t) => {
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
  );
  t.mock.method(thru.transactions, "get", async (signature: string) => {
    finalizedReads += 1;
    assert.equal(signature, "test-signature-15");
    return {
      executionResult: {
        vmError: 0,
        userErrorCode: 0n,
        executionResult: 0n,
      },
    } as never;
  });

  assert.equal(await ensureAccountExists(activeAccount), true);
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
  );
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("Finalized transaction lookup unavailable");
  });

  assert.equal(await ensureAccountExists(activeAccount), true);
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
  );
  t.mock.method(thru.transactions, "get", async () => {
    throw notFound();
  });

  await assert.rejects(
    () =>
      ensureAccountExists(activeAccount, {
        verificationTimeoutMs: 1,
      }),
    (error) =>
      error instanceof SubmittedTransactionUncertainError &&
      error.signature === "test-signature-13",
  );
  await assert.rejects(
    () => ensureAccountExists(activeAccount),
    (error) =>
      error instanceof SubmittedTransactionUncertainError &&
      error.signature === "test-signature-13",
  );
  assert.equal(createCalls, 1);
  assert.equal(sendCalls, 1);
});

test("an interrupted account tracker falls back without rebroadcasting", async (t) => {
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
      throw new Error("upstream tracker reset");
    },
  );
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

  assert.equal(await ensureAccountExists(activeAccount), true);
  assert.equal(sendCalls, 1);
  assert.equal(finalizedReads, 1);
  assert.equal(accountReads, 2);
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate() as never;
    },
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
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
  const activeAccount = account(17);
  let accountReads = 0;
  let accountCreateCalls = 0;
  let faucetBuildCalls = 0;
  let sendCalls = 0;

  t.mock.method(thru.accounts, "get", async (address: string) => {
    const deployment = faucetDeploymentAccount(address);
    if (deployment) return deployment;
    accountReads += 1;
    if (accountReads <= 2) throw notFound();
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
        toThruFmt: () => "test-faucet-signature-17",
      }),
      toWire: () => new Uint8Array([3, 0, 10]),
    } as never;
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("Finalized transaction lookup unavailable");
  });
  t.mock.method(
    thru.transactions,
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(
        sendCalls === 1
          ? ConsensusStatus.OBSERVED
          : ConsensusStatus.FINALIZED,
      ) as never;
    },
  );

  const result = await withdrawFromFaucet(activeAccount);
  assert.equal(result.failureReason, undefined);
  assert.equal(result.signature, "test-faucet-signature-17");
  assert.equal(result.attempts, 1);
  assert.equal(accountCreateCalls, 1);
  assert.equal(faucetBuildCalls, 1);
  assert.equal(sendCalls, 2);
});

test("faucet funding uses read-only fallback after an early tracker end", async (t) => {
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
        toThruFmt: () => "test-faucet-signature-20",
      }),
      toWire: () => new Uint8Array([3, 0, 13]),
    } as never;
  });
  t.mock.method(
    thru.transactions,
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
  );
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

  const result = await withdrawFromFaucet(activeAccount);
  assert.equal(result.failureReason, undefined);
  assert.equal(result.signature, "test-faucet-signature-20");
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
  );

  const result = await withdrawFromFaucet(
    activeAccount,
    FAUCET_WITHDRAW_LIMIT,
    { timeoutMs: 1 },
  );
  assert.equal(result.failureReason, SAFE_FAUCET_UNCERTAIN_MESSAGE);
  assert.equal(result.signature, "test-signature-18");
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
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
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
    getSignature: () => ({ toThruFmt: () => "test-faucet-failed-42" }),
    toWire: () => new Uint8Array([4, 2]),
  }) as never);
  t.mock.method(
    thru.transactions,
    "sendAndTrack",
    async function* () {
      sendCalls += 1;
      yield successfulUpdate(ConsensusStatus.OBSERVED) as never;
    },
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
  assert.equal(result.signature, "test-faucet-failed-42");
  assert.equal(sendCalls, 1);
});
