import assert from "node:assert/strict";
import test from "node:test";
import {
  observeMintState,
  observeTokenAccountState,
} from "../lib/token/thru-token";
import { thru } from "@/lib/wallet/thru-wallet";

const TEST_ADDRESS = "test-address";

test("observeMintState / observeTokenAccountState: RPC error -> gerçek hata olarak korunur", async (t) => {
  t.mock.method(thru.accounts, "get", async () => {
    throw new Error("RPC timeout error");
  });

  await assert.rejects(
    () => observeMintState(TEST_ADDRESS, () => true),
    /RPC timeout error/
  );

  await assert.rejects(
    () => observeTokenAccountState(TEST_ADDRESS, () => true),
    /RPC timeout error/
  );
});

test("observeMintState / observeTokenAccountState: Wrong decode error -> gerçek hata olarak korunur", async (t) => {
  t.mock.method(thru.accounts, "get", async () => {
    return {
      address: TEST_ADDRESS,
      data: new Uint8Array([1, 2, 3]), // Invalid data length, will cause decode error
      owner: "TokenProgram",
      balance: 0n,
    };
  });

  // Decoding should throw, which means it will NOT return false, but propagate the throw.
  await assert.rejects(
    () => observeMintState(TEST_ADDRESS, () => true),
    Error // Some decode error
  );

  await assert.rejects(
    () => observeTokenAccountState(TEST_ADDRESS, () => true),
    Error // Some decode error
  );
});

test("observeMintState / observeTokenAccountState: transient NOT_FOUND error -> polling false döner", async (t) => {
  t.mock.method(thru.accounts, "get", async () => {
    const error = new Error("Account not found") as Error & { code?: number };
    error.code = 5;
    throw error;
  });

  const mintResult = await observeMintState(TEST_ADDRESS, () => true);
  assert.equal(mintResult, false);

  const tokenResult = await observeTokenAccountState(TEST_ADDRESS, () => true);
  assert.equal(tokenResult, false);
});
