import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountConsensusPendingError,
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionUncertainError,
  accountReadFinality,
  assertFinalizedAccount,
  verifySubmittedTransaction,
} from "../lib/thru/transactions";
import { verifyTransferDeltas } from "../lib/token/operations";
import { ConsensusStatus } from "@thru/sdk";
import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";

const SIGNATURE = "public-test-transaction-signature";

function successfulExecution() {
  return {
    vmError: 0,
    userErrorCode: 0n,
    executionResult: 0n,
  };
}

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
