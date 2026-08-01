import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  formatNativeThruAmount,
  NATIVE_THRU_BALANCE_UNIT,
} from "../lib/wallet/native-balance";

test("native balance formatting preserves exact uint64 precision", () => {
  assert.equal(formatNativeThruAmount(0n), "0");
  assert.equal(formatNativeThruAmount(1n), "1");
  assert.equal(formatNativeThruAmount(10_000n), "10000");
  assert.equal(
    formatNativeThruAmount(18_446_744_073_709_551_615n),
    "18446744073709551615",
  );
  assert.equal(NATIVE_THRU_BALANCE_UNIT, "native units");
  assert.throws(() => formatNativeThruAmount(-1n), /negative/);
});

test("Dashboard and wallet popover share the exact native-unit formatter", () => {
  for (const relative of [
    "components/port/PortDashboard.tsx",
    "components/port/PortWalletPopover.tsx",
  ]) {
    const source = readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.match(source, /formatNativeThruAmount\(balance\)/);
    assert.doesNotMatch(source, /Number\(balance\)|formatRawAmount\(balance/);
  }
});
