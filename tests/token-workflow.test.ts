import assert from "node:assert/strict";
import test from "node:test";
import {
  runTokenCreationWorkflow,
  TokenCreationWorkflowError,
  type TokenCreationOperations,
  type TokenCreationProgress,
} from "../lib/token/workflow";

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
