import assert from "node:assert/strict";
import test from "node:test";
import { createThruClient, Pubkey } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import type { TokenAccountInfo } from "@thru/programs/token";
import {
  assertDestinationTokenAccountIdentity,
  assertOfficialTokenProgramOwnership,
  buildDestinationInitializeAccountArgs,
  deriveDestinationTokenAccount,
  ensureDestinationTokenAccount,
} from "../lib/token/destination-account";
import { upsertKnownToken } from "../lib/token/portfolio";
import {
  waitForTransactionVisibility,
} from "../lib/token/transaction-status";

const TOKEN_PROGRAM = BOOTSTRAP_PROGRAM_ADDRESSES.token;
const MINT = "tappwydh_hcIBjPaYFySSCLQA0O6nNzVpZ11AH6SjWs458";
const ACTIVE_WALLET =
  "taBI9fwnX5fT_sJ0cdKKyCLyk72TLw6Rz4wwb-SFdU8aKD";
const DESTINATION_OWNER =
  "tazAmiPNdE28AWH3wPl23zr9Nllg-q6kplDDXOnBS3f9m9";
const EXPECTED_DESTINATION_ACCOUNT =
  "ta2ourpnq7f88E9-qmxwQfK-2c_KL7ZBMkPekvUxOX31IZ";
const thru = createThruClient({
  baseUrl: "https://rpc.alphanet.thru.org",
});

function destinationAccount(
  overrides: Partial<TokenAccountInfo> = {},
): TokenAccountInfo {
  return {
    mint: MINT,
    owner: DESTINATION_OWNER,
    amount: 0n,
    isFrozen: false,
    ...overrides,
  };
}

function preview() {
  return deriveDestinationTokenAccount(thru, {
    mintAddress: MINT,
    destinationOwnerAddress: DESTINATION_OWNER,
    tokenProgramAddress: TOKEN_PROGRAM,
  });
}

test("a different owner derives the deterministic raw-zero token account", () => {
  const first = preview();
  const second = preview();

  assert.equal(first.destinationOwnerAddress, DESTINATION_OWNER);
  assert.notEqual(first.destinationOwnerAddress, ACTIVE_WALLET);
  assert.equal(first.tokenAccountAddress, EXPECTED_DESTINATION_ACCOUNT);
  assert.equal(second.tokenAccountAddress, first.tokenAccountAddress);
  assert.equal(first.seedBytes.length, 32);
  assert.ok(first.seedBytes.every((byte) => byte === 0));
});

test("initialize args contain the destination public owner and raw zero seed", () => {
  const derived = preview();
  const args = buildDestinationInitializeAccountArgs({
    preview: derived,
    stateProof: new Uint8Array([1, 2, 3]),
  });

  assert.deepEqual(
    args.ownerAccountBytes,
    Pubkey.from(DESTINATION_OWNER).toBytes(),
  );
  assert.deepEqual(args.mintAccountBytes, Pubkey.from(MINT).toBytes());
  assert.deepEqual(args.tokenAccountBytes, derived.tokenAccountBytes);
  assert.equal(args.seedBytes.length, 32);
  assert.ok(args.seedBytes.every((byte) => byte === 0));
});

test("destination private key is neither required nor read", () => {
  const publicInput = {
    mintAddress: MINT,
    destinationOwnerAddress: DESTINATION_OWNER,
  };
  Object.defineProperty(publicInput, "destinationPrivateKey", {
    get() {
      throw new Error("destination private key must not be read");
    },
  });

  const derived = deriveDestinationTokenAccount(thru, {
    ...publicInput,
    tokenProgramAddress: TOKEN_PROGRAM,
  });
  assert.equal(derived.tokenAccountAddress, EXPECTED_DESTINATION_ACCOUNT);
});

test("an existing matching account skips transaction submission", async () => {
  let reads = 0;
  let submissions = 0;
  const result = await ensureDestinationTokenAccount(
    {
      tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
      mintAddress: MINT,
      destinationOwnerAddress: DESTINATION_OWNER,
    },
    {
      readOptionalTokenAccount: async () => {
        reads += 1;
        return destinationAccount({ amount: 100n });
      },
      createTokenAccount: async () => {
        submissions += 1;
        return "unexpected";
      },
      readCreatedTokenAccount: async () => {
        throw new Error("post-create read must not run");
      },
    },
  );

  assert.equal(reads, 1);
  assert.equal(submissions, 0);
  assert.equal(result.created, false);
  assert.equal(result.tokenAccount.amount, 100n);
});

test("a second existence check can prevent a duplicate transaction", async () => {
  let reads = 0;
  let submissions = 0;
  const result = await ensureDestinationTokenAccount(
    {
      tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
      mintAddress: MINT,
      destinationOwnerAddress: DESTINATION_OWNER,
    },
    {
      readOptionalTokenAccount: async () => {
        reads += 1;
        return reads === 1 ? null : destinationAccount();
      },
      createTokenAccount: async () => {
        submissions += 1;
        return "unexpected";
      },
      readCreatedTokenAccount: async () => {
        throw new Error("post-create read must not run");
      },
    },
  );

  assert.equal(reads, 2);
  assert.equal(submissions, 0);
  assert.equal(result.created, false);
  assert.equal(result.existenceChecks, 2);
});

test("wrong mint and wrong owner accounts are rejected", async () => {
  const baseInput = {
    tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
    mintAddress: MINT,
    destinationOwnerAddress: DESTINATION_OWNER,
  };
  const operations = (account: TokenAccountInfo) => ({
    readOptionalTokenAccount: async () => account,
    createTokenAccount: async () => "unexpected",
    readCreatedTokenAccount: async () => account,
  });

  await assert.rejects(
    () =>
      ensureDestinationTokenAccount(
        baseInput,
        operations(destinationAccount({ mint: TOKEN_PROGRAM })),
      ),
    /different mint/,
  );
  await assert.rejects(
    () =>
      ensureDestinationTokenAccount(
        baseInput,
        operations(destinationAccount({ owner: ACTIVE_WALLET })),
      ),
    /different owner/,
  );
});

test("wrong Token Program ownership is rejected", () => {
  assert.doesNotThrow(() =>
    assertOfficialTokenProgramOwnership(TOKEN_PROGRAM, TOKEN_PROGRAM, MINT),
  );
  assert.throws(
    () =>
      assertOfficialTokenProgramOwnership(
        ACTIVE_WALLET,
        TOKEN_PROGRAM,
        MINT,
      ),
    /unavailable or belongs to an older AlphaNet program deployment/,
  );
});

test("missing account submits exactly once and verifies post-create state", async () => {
  let existenceReads = 0;
  let submissions = 0;
  let transferSubmissions = 0;
  const operations = {
    readOptionalTokenAccount: async () => {
      existenceReads += 1;
      return null;
    },
    createTokenAccount: async () => {
      submissions += 1;
      return "destination-account-signature";
    },
    readCreatedTokenAccount: async () => destinationAccount(),
    transferTokens: async () => {
      transferSubmissions += 1;
    },
  };

  const result = await ensureDestinationTokenAccount(
    {
      tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
      mintAddress: MINT,
      destinationOwnerAddress: DESTINATION_OWNER,
    },
    operations,
  );

  assert.equal(existenceReads, 2);
  assert.equal(submissions, 1);
  assert.equal(transferSubmissions, 0);
  assert.equal(result.created, true);
  assert.equal(result.signature, "destination-account-signature");
  assert.deepEqual(result.tokenAccount, destinationAccount());
});

test("post-create verification rejects wrong identity, balance, or frozen state", async () => {
  assert.throws(
    () =>
      assertDestinationTokenAccountIdentity({
        tokenAccount: destinationAccount({ mint: TOKEN_PROGRAM }),
        mintAddress: MINT,
        destinationOwnerAddress: DESTINATION_OWNER,
      }),
    /different mint/,
  );

  const attempt = (account: TokenAccountInfo) =>
    ensureDestinationTokenAccount(
      {
        tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
        mintAddress: MINT,
        destinationOwnerAddress: DESTINATION_OWNER,
      },
      {
        readOptionalTokenAccount: async () => null,
        createTokenAccount: async () => "signature",
        readCreatedTokenAccount: async () => account,
      },
    );

  await assert.rejects(
    () => attempt(destinationAccount({ owner: ACTIVE_WALLET })),
    /different owner/,
  );
  await assert.rejects(
    () => attempt(destinationAccount({ amount: 1n })),
    /zero balance/,
  );
  await assert.rejects(
    () => attempt(destinationAccount({ isFrozen: true })),
    /must not be frozen/,
  );
});

test("transient NOT_FOUND polling confirms destination account transaction", async () => {
  let reads = 0;
  let clock = 0;
  const result = await waitForTransactionVisibility({
    signature: "destination-account-signature",
    readStatus: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transaction not found");
      return {
        statusCode: 5,
        executionResult: {
          vmError: 0,
          userErrorCode: 0n,
          executionResult: 0n,
        },
      };
    },
    isFinalConsensus: (status) => status === 5,
    assertExecutionSucceeded: (execution) =>
      execution.vmError === 0 &&
      execution.userErrorCode === 0n &&
      execution.executionResult === 0n,
    timeoutMs: 20,
    initialBackoffMs: 5,
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
  });

  assert.equal(reads, 2);
  assert.equal(result.status?.statusCode, 5);
});

test("expected destination account post-state resolves missing status", async () => {
  let clock = 0;
  const result = await waitForTransactionVisibility({
    signature: "destination-account-signature",
    readStatus: async () => {
      throw new Error("transaction not found");
    },
    verifyExpectedState: async () => true,
    isFinalConsensus: (status) => status === 5,
    assertExecutionSucceeded: () => true,
    timeoutMs: 10,
    initialBackoffMs: 10,
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
  });
  assert.equal(result.source, "post-state");
  assert.equal(result.expectedStateObserved, true);
});

test("a verified destination account is added to known public accounts", () => {
  const records = upsertKnownToken(
    [
      {
        mintAddress: MINT,
        label: "Stage2 Test",
        tokenAccountAddresses: [],
      },
    ],
    {
      mintAddress: MINT,
      tokenAccountAddress: EXPECTED_DESTINATION_ACCOUNT,
    },
  );

  assert.deepEqual(records[0].tokenAccountAddresses, [
    EXPECTED_DESTINATION_ACCOUNT,
  ]);
  assert.equal(records[0].label, "Stage2 Test");
});
