import { EOA_PROGRAM_ID, Pubkey, type Account } from "@thru/sdk";
import { accountReadFinality } from "../thru/transactions";

export const NATIVE_U64_MAX = (1n << 64n) - 1n;
export const NATIVE_TRANSFER_HEADER = Object.freeze({
  fee: 1n, computeUnits: 10_000, stateUnits: 0, memoryUnits: 10_000,
  expiryAfter: 100, flags: 0,
});

export type NativeTransferErrorCode =
  | "INVALID_AMOUNT" | "INVALID_ADDRESS" | "SELF_TRANSFER" | "INVALID_ACCOUNT"
  | "INSUFFICIENT_BALANCE" | "BALANCE_OVERFLOW" | "WRONG_NETWORK"
  | "INVALID_CONTEXT" | "RPC_UNAVAILABLE" | "ABORTED" | "INVALID_IDENTITY"
  | "JOURNAL_UNAVAILABLE" | "PENDING_TRANSFER" | "INVALID_TRANSACTION";

export class NativeTransferError extends Error {
  constructor(readonly code: NativeTransferErrorCode) {
    const messages: Record<NativeTransferErrorCode, string> = {
      INVALID_AMOUNT: "Enter a positive integer amount in raw native units.",
      INVALID_ADDRESS: "Enter a valid Thru recipient address.",
      SELF_TRANSFER: "Sending to your own wallet is not supported.",
      INVALID_ACCOUNT: "An existing supported EOA account is required.",
      INSUFFICIENT_BALANCE: "The balance does not cover the amount and fee.",
      BALANCE_OVERFLOW: "The recipient balance would exceed the supported limit.",
      WRONG_NETWORK: "The RPC does not match Betanet.",
      INVALID_CONTEXT: "A fresh transaction context could not be confirmed.",
      RPC_UNAVAILABLE: "The network request could not be completed safely.",
      ABORTED: "The transfer was cancelled before submission.",
      INVALID_IDENTITY: "The active signing wallet could not be verified.",
      JOURNAL_UNAVAILABLE: "Secure pending-transfer storage is unavailable.",
      PENDING_TRANSFER: "A pending transfer must be verified before another write.",
      INVALID_TRANSACTION: "The transfer transaction does not match the approved intent.",
    };
    super(messages[code]);
    this.name = "NativeTransferError";
  }
}

export function parseNativeTransferAmount(input: string): bigint {
  if (!/^[0-9]+$/.test(input) || input.length > 20) {
    throw new NativeTransferError("INVALID_AMOUNT");
  }
  const amount = BigInt(input);
  if (amount <= 0n || amount > NATIVE_U64_MAX) throw new NativeTransferError("INVALID_AMOUNT");
  return amount;
}

export function nativeTransferAddress(input: string): string {
  try {
    if (!Pubkey.isThruFmt(input)) throw new Error();
    const canonical = Pubkey.from(input).toThruFmt();
    if (canonical !== input) throw new Error();
    return canonical;
  } catch { throw new NativeTransferError("INVALID_ADDRESS"); }
}

export function validateNativeTransferBalances(source: bigint, destination: bigint, amount: bigint): void {
  for (const balance of [source, destination]) {
    if (typeof balance !== "bigint" || balance < 0n || balance > NATIVE_U64_MAX) {
      throw new NativeTransferError("INVALID_ACCOUNT");
    }
  }
  if (amount <= 0n || amount > NATIVE_U64_MAX) throw new NativeTransferError("INVALID_AMOUNT");
  if (amount + NATIVE_TRANSFER_HEADER.fee > source) throw new NativeTransferError("INSUFFICIENT_BALANCE");
  if (destination + amount > NATIVE_U64_MAX) throw new NativeTransferError("BALANCE_OVERFLOW");
}

export function assertNativeEoa(account: Account, address: string): void {
  try {
    accountReadFinality(account); // INCLUDED is readable preflight, never proof of execution.
    const meta = account.meta;
    if (account.address.toThruFmt() !== address || !meta ||
        meta.owner?.toThruFmt() !== EOA_PROGRAM_ID ||
        meta.flags.isProgram !== false || meta.flags.isDeleted !== false ||
        meta.flags.isCompressed !== false || meta.flags.isEphemeral !== false ||
        meta.flags.isNew !== false || account.data?.compressed === true || typeof meta.balance !== "bigint" ||
        meta.balance < 0n || meta.balance > NATIVE_U64_MAX) throw new Error();
  } catch { throw new NativeTransferError("INVALID_ACCOUNT"); }
}

/** Official v0.4.1 txn_tools.rs::build_transfer_instruction. No denomination conversion. */
export function buildNativeTransferInstruction(amount: bigint, sourceIndex = 0, destinationIndex = 2): Uint8Array {
  if (amount <= 0n || amount > NATIVE_U64_MAX) throw new NativeTransferError("INVALID_AMOUNT");
  if (sourceIndex !== 0 || destinationIndex !== 2) throw new NativeTransferError("INVALID_TRANSACTION");
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, amount, true);
  view.setUint16(12, sourceIndex, true);
  view.setUint16(14, destinationIndex, true);
  return bytes;
}
