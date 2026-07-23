import assert from "node:assert/strict";
import test from "node:test";
import {
  TOKEN_AMOUNT_MAX_RAW,
  decimalAmountToRaw,
  validateTokenDecimals,
  validateTokenInput,
  validateTokenName,
  validateTokenTicker,
} from "../lib/token/validation";

test("token name normalizes whitespace and rejects empty, control, or oversized values", () => {
  assert.equal(validateTokenName("  Example   Token  "), "Example Token");
  assert.throws(() => validateTokenName("   "), /required/);
  assert.throws(() => validateTokenName("bad\u0000name"), /control/);
  assert.throws(() => validateTokenName("😀".repeat(17)), /64 UTF-8 bytes/);
});

test("ticker normalizes to uppercase and enforces the Token Studio policy", () => {
  assert.equal(validateTokenTicker(" thru123 "), "THRU123");
  assert.equal(validateTokenTicker("A"), "A");
  assert.throws(() => validateTokenTicker(""), /required/);
  assert.throws(() => validateTokenTicker("1TOKEN"), /start with A-Z/);
  assert.throws(() => validateTokenTicker("TOO-LONG"), /start with A-Z/);
  assert.throws(() => validateTokenTicker("ABCDEFGHI"), /maximum 8/);
});

test("decimals accept only integer values from 0 through 18", () => {
  assert.equal(validateTokenDecimals(0), 0);
  assert.equal(validateTokenDecimals(18), 18);
  assert.throws(() => validateTokenDecimals(-1), /0 to 18/);
  assert.throws(() => validateTokenDecimals(19), /0 to 18/);
  assert.throws(() => validateTokenDecimals(1.5), /integer/);
  assert.throws(() => validateTokenDecimals(Number.NaN), /integer/);
});

test("decimal amount converts to raw BigInt without number arithmetic", () => {
  assert.equal(decimalAmountToRaw("1.23", 6), 1_230_000n);
  assert.equal(decimalAmountToRaw("0.000001", 6), 1n);
  assert.equal(decimalAmountToRaw("100", 0), 100n);
  assert.equal(
    decimalAmountToRaw(TOKEN_AMOUNT_MAX_RAW.toString(), 0),
    TOKEN_AMOUNT_MAX_RAW,
  );
});

test("decimal amount rejects precision loss, overflow, signs, zero, and scientific notation", () => {
  assert.throws(() => decimalAmountToRaw("1.0000001", 6), /at most 6/);
  assert.throws(() => decimalAmountToRaw("18446744073709551616", 0), /exceeds/);
  assert.throws(() => decimalAmountToRaw("-1", 6), /positive/);
  assert.throws(() => decimalAmountToRaw("+1", 6), /positive/);
  assert.throws(() => decimalAmountToRaw("1e6", 6), /Scientific/);
  assert.throws(() => decimalAmountToRaw("1,000", 6), /plain decimal/);
  assert.throws(() => decimalAmountToRaw("0", 6), /greater than zero/);
});

test("complete token input returns normalized metadata and raw initial supply", () => {
  const value = validateTokenInput({
    name: "  Alpha Token ",
    ticker: "alpha",
    decimals: 3,
    initialSupply: "12.345",
  });

  assert.deepEqual(value, {
    name: "Alpha Token",
    ticker: "ALPHA",
    decimals: 3,
    initialSupply: "12.345",
    initialSupplyRaw: 12_345n,
  });
});
