import assert from "node:assert/strict";
import test from "node:test";
import {
  hexToBytes,
  isAccountNotFoundError,
} from "../lib/wallet/thru-wallet";

test("hexToBytes accepts a 32-byte key with either prefix casing", () => {
  const value = `0X${"ab".repeat(32)}`;
  const bytes = hexToBytes(value);

  assert.equal(bytes.length, 32);
  assert.equal(bytes[0], 0xab);
  assert.equal(bytes[31], 0xab);
});

test("hexToBytes rejects invalid length and non-hex characters", () => {
  assert.throws(() => hexToBytes("ab"), /64 hex/);
  assert.throws(() => hexToBytes("zz".repeat(32)), /0-9, a-f/);
});

test("account-not-found detection accepts SDK code and message variants", () => {
  assert.equal(isAccountNotFoundError({ code: 5 }), true);
  assert.equal(
    isAccountNotFoundError(new Error("[not_found] account not found")),
    true,
  );
  assert.equal(isAccountNotFoundError(new Error("gateway unavailable")), false);
});
