import assert from "node:assert/strict";
import test from "node:test";
import { buildFaucetWithdrawInstruction } from "../lib/wallet/faucet";

test("faucet withdraw instruction uses the expected 16-byte LE layout", () => {
  const instruction = buildFaucetWithdrawInstruction(2, 0, 10_000n);
  const view = new DataView(
    instruction.buffer,
    instruction.byteOffset,
    instruction.byteLength,
  );

  assert.equal(instruction.length, 16);
  assert.equal(view.getUint32(0, true), 1);
  assert.equal(view.getUint16(4, true), 2);
  assert.equal(view.getUint16(6, true), 0);
  assert.equal(view.getBigUint64(8, true), 10_000n);
});
