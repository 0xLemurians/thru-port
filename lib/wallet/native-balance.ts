/**
 * AlphaNet account balances are exposed by the official SDK as uint64 values
 * in "native units". SDK 0.3.4 does not publish a decimal-denomination
 * constant for native THRU, so the UI must not invent one.
 */
export function formatNativeThruAmount(rawBalance: bigint): string {
  if (rawBalance < 0n) {
    throw new RangeError("Native balance cannot be negative.");
  }
  return rawBalance.toString();
}

export const NATIVE_THRU_BALANCE_UNIT = "native units";
