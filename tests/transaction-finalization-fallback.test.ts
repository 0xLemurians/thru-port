import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountConsensusPendingError,
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionUncertainError,
  accountReadFinality,
  assertFinalizedAccount,
  submitSignedTransactionOnce,
  verifySubmittedTransaction,
} from "../lib/thru/transactions";
import { verifyTransferDeltas } from "../lib/token/operations";
import { ConsensusStatus, Signature } from "@thru/sdk";
import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";

const SIGNATURE = "public-test-transaction-signature";

function wireSignature(byte: number): string {
  return Signature.from(new Uint8Array(64).fill(byte)).toThruFmt();
}

function statusSnapshot(
  byte: number,
  statusCode: ConsensusStatus,
  executionResult = successfulExecution(),
) {
  return {
    signature: new Uint8Array(64).fill(byte),
    statusCode,
    executionResult,
  };
}

function successfulExecution() {
  return {
    vmError: 0,
    userErrorCode: 0n,
    executionResult: 0n,
  };
}

test("unary submission occurs once and getStatus is polled to finalized execution", async () => {
  const signature = wireSignature(51);
  let sendCalls = 0;
  let statusCalls = 0;
  const result = await submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([1, 2, 3]),
    expectedSignature: signature,
    send: async () => {
      sendCalls += 1;
      return signature;
    },
    getStatus: async () => {
      statusCalls += 1;
      return statusSnapshot(
        51,
        statusCalls === 1
          ? ConsensusStatus.INCLUDED
          : ConsensusStatus.FINALIZED,
      );
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(result, {
    signature,
    executionSucceeded: true,
    finalized: true,
    statusTimedOut: false,
  });
  assert.equal(sendCalls, 1);
  assert.equal(statusCalls, 2);
});

test("unary submission signature mismatch fails closed without status polling", async () => {
  const expectedSignature = wireSignature(52);
  let sendCalls = 0;
  let statusCalls = 0;

  await assert.rejects(
    () =>
      submitSignedTransactionOnce({
        rawTransaction: new Uint8Array([4, 5, 6]),
        expectedSignature,
        send: async () => {
          sendCalls += 1;
          return wireSignature(53);
        },
        getStatus: async () => {
          statusCalls += 1;
          return statusSnapshot(52, ConsensusStatus.FINALIZED);
        },
      }),
    (error: unknown) =>
      error instanceof SubmittedTransactionUncertainError &&
      error.signature === expectedSignature,
  );

  assert.equal(sendCalls, 1);
  assert.equal(statusCalls, 0);
});

test("getStatus execution error preserves vmError and userErrorCode", async () => {
  const signature = wireSignature(54);
  const result = await submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([7, 8, 9]),
    expectedSignature: signature,
    send: async () => signature,
    getStatus: async () =>
      statusSnapshot(54, ConsensusStatus.INCLUDED, {
        vmError: 27,
        userErrorCode: 99n,
        executionResult: 0n,
      }),
  });

  assert.deepEqual(result, {
    signature,
    executionSucceeded: false,
    finalized: false,
    statusTimedOut: false,
    failure: { vmError: 27, userErrorCode: 99n },
  });
});

test("status timeout remains uncertain and never rebroadcasts", async () => {
  const signature = wireSignature(55);
  let sendCalls = 0;
  let statusCalls = 0;
  let clock = 0;
  const diagnostics: unknown[] = [];
  const result = await submitSignedTransactionOnce({
    rawTransaction: new Uint8Array([10, 11, 12]),
    expectedSignature: signature,
    timeoutMs: 10,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    send: async () => {
      sendCalls += 1;
      return signature;
    },
    getStatus: async () => {
      statusCalls += 1;
      throw new Error("read-only status unavailable");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(result, {
    signature,
    executionSucceeded: false,
    finalized: false,
    statusTimedOut: true,
  });
  assert.equal(sendCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(
    diagnostics.some(
      (entry) =>
        (entry as { error?: Error }).error?.message ===
        "Transaction status polling timed out.",
    ),
    true,
  );
});

test("submit diagnostics retain the real RPC error without rebroadcasting", async () => {
  const signature = wireSignature(56);
  const rpcError = new Error("command endpoint returned unavailable");
  let sendCalls = 0;
  const diagnostics: Array<{ error?: unknown }> = [];

  await assert.rejects(
    () =>
      submitSignedTransactionOnce({
        rawTransaction: new Uint8Array([13, 14, 15]),
        expectedSignature: signature,
        send: async () => {
          sendCalls += 1;
          throw rpcError;
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    SubmittedTransactionUncertainError,
  );

  assert.equal(sendCalls, 1);
  assert.equal(diagnostics.at(-1)?.error, rpcError);
});

test("INCLUDED is readable but remains provisional for normal account views", () => {
  assert.equal(
    accountReadFinality({ consensusStatus: ConsensusStatus.INCLUDED }),
    "provisional",
  );
  assert.throws(
    () => assertFinalizedAccount({ consensusStatus: ConsensusStatus.INCLUDED }),
    AccountConsensusPendingError,
  );
});

test("FINALIZED and CLUSTER_EXECUTED retain authoritative read behavior", () => {
  for (const consensusStatus of [
    ConsensusStatus.FINALIZED,
    ConsensusStatus.CLUSTER_EXECUTED,
  ]) {
    assert.equal(accountReadFinality({ consensusStatus }), "finalized");
    assert.doesNotThrow(() => assertFinalizedAccount({ consensusStatus }));
  }
});

test("INCLUDED post-state cannot finalize transaction reconciliation", async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      verifySubmittedTransaction({
        signature: SIGNATURE,
        readFinalizedTransaction: async () => {
          throw new Error("transaction not finalized");
        },
        verifyExpectedState: async () => {
          assertFinalizedAccount({
            consensusStatus: ConsensusStatus.INCLUDED,
          });
          return true;
        },
        timeoutMs: 1,
        initialBackoffMs: 1,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
      }),
    SubmittedTransactionUncertainError,
  );
});

test("finalized read-only transaction execution confirms success", async () => {
  let postStateReads = 0;
  const result = await verifySubmittedTransaction({
    signature: SIGNATURE,
    readFinalizedTransaction: async () => ({
      executionResult: successfulExecution(),
    }),
    verifyExpectedState: async () => {
      postStateReads += 1;
      return false;
    },
  });

  assert.deepEqual(result, {
    outcome: "success",
    source: "finalized-transaction",
  });
  assert.equal(postStateReads, 0);
});

test("finalized execution failure remains a verified failure", async () => {
  const result = await verifySubmittedTransaction({
    signature: SIGNATURE,
    readFinalizedTransaction: async () => ({
      executionResult: {
        vmError: 1,
        userErrorCode: 0n,
        executionResult: 0n,
      },
    }),
    verifyExpectedState: async () => true,
  });

  assert.deepEqual(result, {
    outcome: "failure",
    source: "finalized-transaction",
  });
});

test("exact token transfer post-state confirms success when finalized lookup is unavailable", async () => {
  const mint = {
    supply: 100n,
    decimals: 2,
    creator: "creator",
    mintAuthority: "authority",
    freezeAuthority: "freeze",
    hasFreezeAuthority: true,
    ticker: "TEST",
  } as MintAccountInfo;
  const source = {
    amount: 70n,
    mint: "mint",
    owner: "owner",
    isFrozen: false,
  } as TokenAccountInfo;
  const destination = {
    amount: 30n,
    mint: "mint",
    owner: "recipient",
    isFrozen: false,
  } as TokenAccountInfo;

  const result = await verifySubmittedTransaction({
    signature: SIGNATURE,
    readFinalizedTransaction: async () => {
      throw new Error("transport unavailable");
    },
    verifyExpectedState: async () => {
      verifyTransferDeltas({
        amount: 10n,
        beforeMint: mint,
        afterMint: { ...mint, supply: 100n },
        beforeSource: source,
        afterSource: { ...source, amount: 60n },
        beforeDestination: destination,
        afterDestination: { ...destination, amount: 40n },
      });
      return true;
    },
  });

  assert.deepEqual(result, {
    outcome: "success",
    source: "post-state",
  });
});

test("authoritative post-state mismatch remains failure", async () => {
  const result = await verifySubmittedTransaction({
    signature: SIGNATURE,
    readFinalizedTransaction: async () => {
      throw new Error("transaction not found");
    },
    verifyExpectedState: async () => {
      throw new Error("Exact balance deltas do not match");
    },
    classifyExpectedStateError: () => "failure",
  });

  assert.deepEqual(result, {
    outcome: "failure",
    source: "post-state",
  });
});

test("missing finalized transaction and missing post-state remain safely uncertain", async () => {
  let clock = 0;
  let finalizedReads = 0;
  let postStateReads = 0;

  await assert.rejects(
    () =>
      verifySubmittedTransaction({
        signature: SIGNATURE,
        readFinalizedTransaction: async () => {
          finalizedReads += 1;
          throw new Error(
            "upstream gRPC transport connection refused at https://internal",
          );
        },
        verifyExpectedState: async () => {
          postStateReads += 1;
          return false;
        },
        timeoutMs: 10,
        initialBackoffMs: 10,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SubmittedTransactionUncertainError);
      assert.equal(error.signature, SIGNATURE);
      assert.equal(error.message, SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
      assert.doesNotMatch(
        error.message,
        /grpc|transport|connection|https?:/i,
      );
      return true;
    },
  );

  assert.equal(finalizedReads, 2);
  assert.equal(postStateReads, 2);
});

test("abort discards a stale finalized lookup result and stops further polling", async () => {
  const controller = new AbortController();
  let releaseRead:
    | ((value: { executionResult: ReturnType<typeof successfulExecution> }) => void)
    | undefined;
  let postStateReads = 0;
  const pending = verifySubmittedTransaction({
    signature: SIGNATURE,
    readFinalizedTransaction: () =>
      new Promise((resolve) => {
        releaseRead = resolve;
      }),
    verifyExpectedState: async () => {
      postStateReads += 1;
      return true;
    },
    signal: controller.signal,
  });

  controller.abort();
  releaseRead?.({ executionResult: successfulExecution() });

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(postStateReads, 0);
});
