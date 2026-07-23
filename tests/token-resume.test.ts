import assert from "node:assert/strict";
import test from "node:test";
import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";
import { planTokenSetupResume } from "../lib/token/resume";

const WALLET = "wallet";
const MINT = "mint";

function mint(overrides: Partial<MintAccountInfo> = {}): MintAccountInfo {
  return {
    decimals: 2,
    supply: 0n,
    creator: WALLET,
    mintAuthority: WALLET,
    freezeAuthority: null,
    hasFreezeAuthority: false,
    ticker: "S2T",
    ...overrides,
  };
}

function tokenAccount(
  overrides: Partial<TokenAccountInfo> = {},
): TokenAccountInfo {
  return {
    mint: MINT,
    owner: WALLET,
    amount: 0n,
    isFrozen: false,
    ...overrides,
  };
}

test("existing mint with a missing token account resumes both remaining steps", () => {
  const plan = planTokenSetupResume({
    mintAddress: MINT,
    ownerAddress: WALLET,
    mint: mint(),
    tokenAccount: null,
  });

  assert.deepEqual(plan, {
    createTokenAccount: true,
    mintInitialSupply: true,
    tokenAccountAlreadyExisted: false,
    initialSupplyAlreadyPresent: false,
  });
});

test("an existing matching token account skips account creation", () => {
  const plan = planTokenSetupResume({
    mintAddress: MINT,
    ownerAddress: WALLET,
    mint: mint(),
    tokenAccount: tokenAccount(),
  });

  assert.equal(plan.createTokenAccount, false);
  assert.equal(plan.tokenAccountAlreadyExisted, true);
  assert.equal(plan.mintInitialSupply, true);
});

test("non-zero mint supply blocks a duplicate initial-supply mint", () => {
  const plan = planTokenSetupResume({
    mintAddress: MINT,
    ownerAddress: WALLET,
    mint: mint({ supply: 10_000n }),
    tokenAccount: tokenAccount({ amount: 10_000n }),
  });

  assert.equal(plan.createTokenAccount, false);
  assert.equal(plan.mintInitialSupply, false);
  assert.equal(plan.initialSupplyAlreadyPresent, true);
});

test("resume rejects an active wallet that is not the mint authority", () => {
  assert.throws(
    () =>
      planTokenSetupResume({
        mintAddress: MINT,
        ownerAddress: WALLET,
        mint: mint({ mintAuthority: "different-wallet" }),
        tokenAccount: null,
      }),
    /not this mint's mint authority/,
  );
});

test("resume rejects a mismatched, foreign, frozen, or inconsistent account", () => {
  assert.throws(
    () =>
      planTokenSetupResume({
        mintAddress: MINT,
        ownerAddress: WALLET,
        mint: mint(),
        tokenAccount: tokenAccount({ mint: "different-mint" }),
      }),
    /different mint/,
  );
  assert.throws(
    () =>
      planTokenSetupResume({
        mintAddress: MINT,
        ownerAddress: WALLET,
        mint: mint(),
        tokenAccount: tokenAccount({ owner: "different-wallet" }),
      }),
    /different owner/,
  );
  assert.throws(
    () =>
      planTokenSetupResume({
        mintAddress: MINT,
        ownerAddress: WALLET,
        mint: mint(),
        tokenAccount: tokenAccount({ isFrozen: true }),
      }),
    /frozen/,
  );
  assert.throws(
    () =>
      planTokenSetupResume({
        mintAddress: MINT,
        ownerAddress: WALLET,
        mint: mint(),
        tokenAccount: tokenAccount({ amount: 1n }),
      }),
    /exceeds|supply is zero/,
  );
});
