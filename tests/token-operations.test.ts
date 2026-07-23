import assert from "node:assert/strict";
import test from "node:test";
import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";
import {
  validateMintToPreflight,
  validateTransferPreflight,
  verifyMintToDeltas,
  verifyTransferDeltas,
} from "../lib/token/operations";

const WALLET = "wallet";
const MINT = "mint";
const OTHER_MINT = "other-mint";

function mint(
  overrides: Partial<MintAccountInfo> = {},
): MintAccountInfo {
  return {
    decimals: 2,
    supply: 10_000n,
    creator: WALLET,
    mintAuthority: WALLET,
    freezeAuthority: null,
    hasFreezeAuthority: false,
    ticker: "TST",
    ...overrides,
  };
}

function tokenAccount(
  overrides: Partial<TokenAccountInfo> = {},
): TokenAccountInfo {
  return {
    mint: MINT,
    owner: WALLET,
    amount: 5_000n,
    isFrozen: false,
    ...overrides,
  };
}

test("additional supply requires the active wallet to be mint authority", () => {
  assert.throws(
    () =>
      validateMintToPreflight({
        mintAddress: MINT,
        destinationAddress: "destination",
        activeWalletAddress: WALLET,
        amount: "1",
        mint: mint({ mintAuthority: "different-wallet" }),
        destination: tokenAccount(),
      }),
    /not this mint's mint authority/,
  );
});

test("additional supply rejects a target attached to another mint", () => {
  assert.throws(
    () =>
      validateMintToPreflight({
        mintAddress: MINT,
        destinationAddress: "destination",
        activeWalletAddress: WALLET,
        amount: "1",
        mint: mint(),
        destination: tokenAccount({ mint: OTHER_MINT }),
      }),
    /different mint/,
  );
});

test("frozen accounts are rejected for minting and transfer", () => {
  assert.throws(
    () =>
      validateMintToPreflight({
        mintAddress: MINT,
        destinationAddress: "destination",
        activeWalletAddress: WALLET,
        amount: "1",
        mint: mint(),
        destination: tokenAccount({ isFrozen: true }),
      }),
    /frozen/,
  );

  assert.throws(
    () =>
      validateTransferPreflight({
        mintAddress: MINT,
        sourceAddress: "source",
        destinationAddress: "destination",
        activeWalletAddress: WALLET,
        amount: "1",
        mint: mint(),
        source: tokenAccount(),
        destination: tokenAccount({ isFrozen: true }),
      }),
    /Frozen/,
  );
});

test("transfer rejects wrong mint, wrong owner, self-transfer, and insufficient balance", () => {
  const base = {
    mintAddress: MINT,
    sourceAddress: "source",
    destinationAddress: "destination",
    activeWalletAddress: WALLET,
    amount: "1",
    mint: mint(),
    source: tokenAccount({ amount: 50n }),
    destination: tokenAccount(),
  };

  assert.throws(
    () =>
      validateTransferPreflight({
        ...base,
        destination: tokenAccount({ mint: OTHER_MINT }),
      }),
    /same mint/,
  );
  assert.throws(
    () =>
      validateTransferPreflight({
        ...base,
        source: tokenAccount({ owner: "different-wallet" }),
      }),
    /not owned/,
  );
  assert.throws(
    () =>
      validateTransferPreflight({
        ...base,
        destinationAddress: "source",
      }),
    /must be different/,
  );
  assert.throws(() => validateTransferPreflight(base), /insufficient/);
});

test("operation amounts convert decimal text to raw BigInt", () => {
  const raw = validateMintToPreflight({
    mintAddress: MINT,
    destinationAddress: "destination",
    activeWalletAddress: WALLET,
    amount: "12.34",
    mint: mint(),
    destination: tokenAccount(),
  });

  assert.equal(raw, 1_234n);
  assert.equal(typeof raw, "bigint");
});

test("additional supply verification requires exact supply and balance deltas", () => {
  const beforeMint = mint();
  const beforeDestination = tokenAccount();
  const amount = 250n;

  assert.doesNotThrow(() =>
    verifyMintToDeltas({
      amount,
      beforeMint,
      afterMint: mint({ supply: beforeMint.supply + amount }),
      beforeDestination,
      afterDestination: tokenAccount({
        amount: beforeDestination.amount + amount,
      }),
    }),
  );

  assert.throws(
    () =>
      verifyMintToDeltas({
        amount,
        beforeMint,
        afterMint: mint({ supply: beforeMint.supply + amount - 1n }),
        beforeDestination,
        afterDestination: tokenAccount({
          amount: beforeDestination.amount + amount,
        }),
      }),
    /supply/,
  );
  assert.throws(
    () =>
      verifyMintToDeltas({
        amount,
        beforeMint,
        afterMint: mint({ supply: beforeMint.supply + amount }),
        beforeDestination,
        afterDestination: tokenAccount({
          amount: beforeDestination.amount + amount - 1n,
        }),
      }),
    /balance/,
  );
});

test("transfer verification requires exact balance deltas and unchanged supply", () => {
  const beforeMint = mint();
  const beforeSource = tokenAccount({ amount: 5_000n });
  const beforeDestination = tokenAccount({ owner: "recipient", amount: 900n });
  const amount = 125n;
  const valid = {
    amount,
    beforeMint,
    afterMint: mint(),
    beforeSource,
    afterSource: tokenAccount({ amount: beforeSource.amount - amount }),
    beforeDestination,
    afterDestination: tokenAccount({
      owner: "recipient",
      amount: beforeDestination.amount + amount,
    }),
  };

  assert.doesNotThrow(() => verifyTransferDeltas(valid));
  assert.throws(
    () =>
      verifyTransferDeltas({
        ...valid,
        afterMint: mint({ supply: beforeMint.supply + 1n }),
      }),
    /supply changed/,
  );
  assert.throws(
    () =>
      verifyTransferDeltas({
        ...valid,
        afterSource: tokenAccount({
          amount: beforeSource.amount - amount + 1n,
        }),
      }),
    /Source token balance/,
  );
  assert.throws(
    () =>
      verifyTransferDeltas({
        ...valid,
        afterDestination: tokenAccount({
          owner: "recipient",
          amount: beforeDestination.amount + amount - 1n,
        }),
      }),
    /Destination token balance/,
  );
});
