import assert from "node:assert/strict";
import test from "node:test";
import {
  runTokenCreationWorkflow,
  runTokenMutationWorkflow,
  TokenCreationWorkflowError,
  TokenMutationWorkflowError,
  type TokenCreationOperations,
  type TokenCreationProgress,
  type TokenMutationProgress,
} from "../lib/token/workflow";
import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  TransactionStatusUncertainError,
} from "../lib/token/transaction-status";

function successfulOperations(): TokenCreationOperations {
  return {
    validate: async () => undefined,
    createMint: async (onSubmitted) => {
      onSubmitted("mint-signature");
      return { signature: "mint-signature" };
    },
    createTokenAccount: async (onSubmitted) => {
      onSubmitted("account-signature");
      return { signature: "account-signature" };
    },
    mintInitialSupply: async (onSubmitted) => {
      onSubmitted("supply-signature");
      return { signature: "supply-signature" };
    },
    verifyOnChainState: async () => undefined,
  };
}

test("token workflow exposes all transaction and verification stages in order", async () => {
  const updates: TokenCreationProgress[] = [];
  const result = await runTokenCreationWorkflow(
    successfulOperations(),
    (progress) => updates.push(progress),
  );

  assert.deepEqual(result, {
    mint: { signature: "mint-signature" },
    tokenAccount: { signature: "account-signature" },
    initialSupply: { signature: "supply-signature" },
  });
  assert.deepEqual(
    updates.map((update) => update.stage),
    [
      "validating",
      "creating-mint",
      "waiting-mint-finalization",
      "creating-token-account",
      "waiting-account-finalization",
      "minting-initial-supply",
      "minting-initial-supply",
      "verifying-on-chain-state",
      "completed",
    ],
  );
  assert.deepEqual(
    updates
      .filter((update) => update.signature)
      .map((update) => [update.transactionKind, update.signature]),
    [
      ["mint", "mint-signature"],
      ["token-account", "account-signature"],
      ["initial-supply", "supply-signature"],
    ],
  );
});

test("failure before token-account submission reports the creating-account stage", async () => {
  const updates: TokenCreationProgress[] = [];
  let initialSupplyCalled = false;
  let verificationCalled = false;
  const operations = successfulOperations();
  operations.createTokenAccount = async () => {
    throw new Error("account build failed");
  };
  operations.mintInitialSupply = async () => {
    initialSupplyCalled = true;
    return { signature: "unexpected" };
  };
  operations.verifyOnChainState = async () => {
    verificationCalled = true;
  };

  await assert.rejects(
    () =>
      runTokenCreationWorkflow(operations, (progress) =>
        updates.push(progress),
      ),
    (error: unknown) => {
      assert.ok(error instanceof TokenCreationWorkflowError);
      assert.equal(error.failedAt, "creating-token-account");
      assert.match(error.message, /account build failed/);
      return true;
    },
  );

  assert.equal(initialSupplyCalled, false);
  assert.equal(verificationCalled, false);
  assert.deepEqual(updates.at(-1), {
    stage: "failed",
    failedAt: "creating-token-account",
    error: "account build failed",
  });
});

test("failure after a signature is attributed to its finalization stage", async () => {
  const updates: TokenCreationProgress[] = [];
  const operations = successfulOperations();
  operations.createMint = async (onSubmitted) => {
    onSubmitted("mint-signature");
    throw new Error("final consensus timeout");
  };

  await assert.rejects(
    () =>
      runTokenCreationWorkflow(operations, (progress) =>
        updates.push(progress),
      ),
    (error: unknown) => {
      assert.ok(error instanceof TokenCreationWorkflowError);
      assert.equal(error.failedAt, "waiting-mint-finalization");
      return true;
    },
  );

  assert.equal(updates.at(-1)?.stage, "failed");
  assert.equal(updates.at(-1)?.failedAt, "waiting-mint-finalization");
});

test("initial-supply execution failure stops before on-chain verification", async () => {
  const updates: TokenCreationProgress[] = [];
  let verificationCalled = false;
  const operations = successfulOperations();
  operations.mintInitialSupply = async (onSubmitted) => {
    onSubmitted("supply-signature");
    throw new Error("vmError: -1");
  };
  operations.verifyOnChainState = async () => {
    verificationCalled = true;
  };

  await assert.rejects(
    () =>
      runTokenCreationWorkflow(operations, (progress) =>
        updates.push(progress),
      ),
    (error: unknown) => {
      assert.ok(error instanceof TokenCreationWorkflowError);
      assert.equal(error.failedAt, "minting-initial-supply");
      assert.match(error.message, /vmError/);
      return true;
    },
  );

  assert.equal(verificationCalled, false);
});

test("unconfirmed transaction status is reported as uncertain, not failed", async () => {
  const updates: TokenCreationProgress[] = [];
  let tokenAccountCalled = false;
  const operations = successfulOperations();
  operations.createMint = async (onSubmitted) => {
    onSubmitted("mint-signature");
    throw new TransactionStatusUncertainError("mint-signature", true);
  };
  operations.createTokenAccount = async () => {
    tokenAccountCalled = true;
    return { signature: "unexpected" };
  };

  await assert.rejects(
    () =>
      runTokenCreationWorkflow(operations, (progress) =>
        updates.push(progress),
      ),
    TransactionStatusUncertainError,
  );

  assert.equal(tokenAccountCalled, false);
  assert.deepEqual(updates.at(-1), {
    stage: "uncertain",
    uncertainAt: "waiting-mint-finalization",
    error: SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
    signature: "mint-signature",
    expectedStateObserved: true,
  });
  assert.equal(updates.some((update) => update.stage === "failed"), false);
});

test("token mutation exposes the shared transaction stages in order", async () => {
  const updates: TokenMutationProgress[] = [];
  const result = await runTokenMutationWorkflow(
    {
      validate: async () => undefined,
      execute: async (callbacks) => {
        callbacks.onAwaitingFinalConsensus();
        callbacks.onSubmitted("mutation-signature");
        callbacks.onFinalConsensus();
        return { signature: "mutation-signature" };
      },
      refetchAndVerify: async () => "verified",
    },
    (progress) => updates.push(progress),
  );

  assert.deepEqual(result, {
    signature: "mutation-signature",
    result: "verified",
  });
  assert.deepEqual(
    updates.map((update) => update.stage),
    [
      "validating",
      "building-transaction",
      "waiting-final-consensus",
      "waiting-final-consensus",
      "verifying-execution",
      "refetching-on-chain-state",
      "completed",
    ],
  );
});

test("a failed token mutation is never submitted automatically a second time", async () => {
  const updates: TokenMutationProgress[] = [];
  let submissions = 0;
  let refetches = 0;

  await assert.rejects(
    () =>
      runTokenMutationWorkflow(
        {
          validate: async () => undefined,
          execute: async (callbacks) => {
            submissions += 1;
            callbacks.onSubmitted("failed-signature");
            callbacks.onFinalConsensus();
            throw new Error("vmError: -1");
          },
          refetchAndVerify: async () => {
            refetches += 1;
          },
        },
        (progress) => updates.push(progress),
      ),
    (error: unknown) => {
      assert.ok(error instanceof TokenMutationWorkflowError);
      assert.equal(error.signature, "failed-signature");
      assert.equal(error.failedAt, "verifying-execution");
      return true;
    },
  );

  assert.equal(submissions, 1);
  assert.equal(refetches, 0);
  assert.deepEqual(updates.at(-1), {
    stage: "failed",
    failedAt: "verifying-execution",
    error: "vmError: -1",
    signature: "failed-signature",
  });
});
