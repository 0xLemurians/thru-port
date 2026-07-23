import assert from "node:assert/strict";
import test from "node:test";
import {
  TransactionStatusUncertainError,
  waitForTransactionVisibility,
  type TransactionStatusLike,
} from "../lib/token/transaction-status";

const SUCCESSFUL_FINAL_STATUS: TransactionStatusLike = {
  statusCode: 4,
  executionResult: {
    vmError: 0,
    userErrorCode: 0n,
    executionResult: 0n,
  },
};

const isFinalConsensus = (status: number) => status === 4;
const assertExecutionSucceeded = (
  execution: NonNullable<TransactionStatusLike["executionResult"]>,
) =>
  execution.vmError === 0 &&
  execution.userErrorCode === 0n &&
  execution.executionResult === 0n;

test("a transient first NOT_FOUND status is polled until final success", async () => {
  let reads = 0;
  let clock = 0;
  const result = await waitForTransactionVisibility({
    signature: "signature",
    readStatus: async () => {
      reads += 1;
      if (reads === 1) {
        throw Object.assign(new Error("[not_found] transaction not found"), {
          code: 5,
        });
      }
      return SUCCESSFUL_FINAL_STATUS;
    },
    isFinalConsensus,
    assertExecutionSucceeded,
    timeoutMs: 50,
    initialBackoffMs: 5,
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
  });

  assert.equal(reads, 2);
  assert.equal(result.status, SUCCESSFUL_FINAL_STATUS);
});

test("NOT_FOUND retries status reads without resubmitting the transaction", async () => {
  let submissions = 0;
  let reads = 0;
  let clock = 0;
  const submitOnce = async () => {
    submissions += 1;
    return "already-submitted-signature";
  };
  const signature = await submitOnce();

  await waitForTransactionVisibility({
    signature,
    readStatus: async () => {
      reads += 1;
      if (reads < 3) throw new Error("transaction not found");
      return SUCCESSFUL_FINAL_STATUS;
    },
    isFinalConsensus,
    assertExecutionSucceeded,
    timeoutMs: 50,
    initialBackoffMs: 5,
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
  });

  assert.equal(submissions, 1);
  assert.equal(reads, 3);
});

test("visibility timeout reports an uncertain status instead of failure", async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForTransactionVisibility({
        signature: "unconfirmed-signature",
        readStatus: async () => {
          throw new Error("[not_found] transaction not found");
        },
        isFinalConsensus,
        assertExecutionSucceeded,
        timeoutMs: 10,
        initialBackoffMs: 10,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof TransactionStatusUncertainError);
      assert.equal(error.signature, "unconfirmed-signature");
      assert.equal(error.expectedStateObserved, false);
      assert.equal(
        error.message,
        "Transaction submitted but final status could not be confirmed",
      );
      return true;
    },
  );
});

test("visibility polling can be cancelled with AbortSignal", async () => {
  const controller = new AbortController();

  await assert.rejects(
    () =>
      waitForTransactionVisibility({
        signature: "cancelled-signature",
        readStatus: async () => {
          throw new Error("transaction not found");
        },
        isFinalConsensus,
        assertExecutionSucceeded,
        signal: controller.signal,
        timeoutMs: 1_000,
        sleep: async (_delay, signal) => {
          controller.abort();
          signal?.throwIfAborted();
        },
      }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    },
  );
});

test("uncertain status retains evidence that the expected account exists", async () => {
  let clock = 0;
  let accountVerifications = 0;

  await assert.rejects(
    () =>
      waitForTransactionVisibility({
        signature: "state-observed-signature",
        readStatus: async () => {
          throw new Error("transaction not found");
        },
        isFinalConsensus,
        assertExecutionSucceeded,
        verifyExpectedState: async () => {
          accountVerifications += 1;
          return true;
        },
        timeoutMs: 10,
        initialBackoffMs: 10,
        now: () => clock,
        sleep: async (delay) => {
          clock += delay;
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof TransactionStatusUncertainError);
      assert.equal(error.expectedStateObserved, true);
      return true;
    },
  );

  assert.equal(accountVerifications, 1);
});
