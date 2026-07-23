import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";
import {
  TOKEN_AMOUNT_MAX_RAW,
  decimalAmountToRaw,
} from "./validation";

export interface MintToPreflight {
  mintAddress: string;
  destinationAddress: string;
  activeWalletAddress: string;
  amount: string;
  mint: MintAccountInfo;
  destination: TokenAccountInfo;
}

export interface TransferPreflight {
  mintAddress: string;
  sourceAddress: string;
  destinationAddress: string;
  activeWalletAddress: string;
  amount: string;
  mint: MintAccountInfo;
  source: TokenAccountInfo;
  destination: TokenAccountInfo;
}

export function validateMintToPreflight(input: MintToPreflight): bigint {
  if (input.mint.mintAuthority !== input.activeWalletAddress) {
    throw new Error("The active wallet is not this mint's mint authority.");
  }
  if (input.destination.mint !== input.mintAddress) {
    throw new Error("The destination token account belongs to a different mint.");
  }
  if (input.destination.isFrozen) {
    throw new Error("Cannot mint to a frozen token account.");
  }

  const remainingSupply = TOKEN_AMOUNT_MAX_RAW - input.mint.supply;
  const remainingBalance = TOKEN_AMOUNT_MAX_RAW - input.destination.amount;
  const maximum =
    remainingSupply < remainingBalance ? remainingSupply : remainingBalance;
  return decimalAmountToRaw(input.amount, input.mint.decimals, maximum, "Amount");
}

export function validateTransferPreflight(input: TransferPreflight): bigint {
  if (input.sourceAddress === input.destinationAddress) {
    throw new Error("Source and destination token accounts must be different.");
  }
  if (input.source.owner !== input.activeWalletAddress) {
    throw new Error("The source token account is not owned by the active wallet.");
  }
  if (
    input.source.mint !== input.mintAddress ||
    input.destination.mint !== input.mintAddress
  ) {
    throw new Error("Source and destination must belong to the same mint.");
  }
  if (input.source.isFrozen || input.destination.isFrozen) {
    throw new Error("Frozen token accounts cannot participate in transfers.");
  }

  const rawAmount = decimalAmountToRaw(
    input.amount,
    input.mint.decimals,
    TOKEN_AMOUNT_MAX_RAW,
    "Amount",
  );
  if (rawAmount > input.source.amount) {
    throw new Error("The source token account has insufficient balance.");
  }
  return rawAmount;
}

export function verifyMintToDeltas(input: {
  amount: bigint;
  beforeMint: MintAccountInfo;
  afterMint: MintAccountInfo;
  beforeDestination: TokenAccountInfo;
  afterDestination: TokenAccountInfo;
}): void {
  if (input.afterMint.supply !== input.beforeMint.supply + input.amount) {
    throw new Error("Mint supply did not increase by the submitted amount.");
  }
  if (
    input.afterDestination.amount !==
    input.beforeDestination.amount + input.amount
  ) {
    throw new Error(
      "Destination token balance did not increase by the submitted amount.",
    );
  }
  assertMintIdentityUnchanged(input.beforeMint, input.afterMint);
  assertTokenIdentityUnchanged(
    input.beforeDestination,
    input.afterDestination,
  );
}

export function verifyTransferDeltas(input: {
  amount: bigint;
  beforeMint: MintAccountInfo;
  afterMint: MintAccountInfo;
  beforeSource: TokenAccountInfo;
  afterSource: TokenAccountInfo;
  beforeDestination: TokenAccountInfo;
  afterDestination: TokenAccountInfo;
}): void {
  if (input.afterMint.supply !== input.beforeMint.supply) {
    throw new Error("Mint supply changed during the transfer.");
  }
  if (input.afterSource.amount !== input.beforeSource.amount - input.amount) {
    throw new Error("Source token balance did not decrease by the submitted amount.");
  }
  if (
    input.afterDestination.amount !==
    input.beforeDestination.amount + input.amount
  ) {
    throw new Error(
      "Destination token balance did not increase by the submitted amount.",
    );
  }
  assertMintIdentityUnchanged(input.beforeMint, input.afterMint);
  assertTokenIdentityUnchanged(input.beforeSource, input.afterSource);
  assertTokenIdentityUnchanged(
    input.beforeDestination,
    input.afterDestination,
  );
}

function assertMintIdentityUnchanged(
  before: MintAccountInfo,
  after: MintAccountInfo,
): void {
  if (
    after.decimals !== before.decimals ||
    after.creator !== before.creator ||
    after.mintAuthority !== before.mintAuthority ||
    after.freezeAuthority !== before.freezeAuthority ||
    after.hasFreezeAuthority !== before.hasFreezeAuthority ||
    after.ticker !== before.ticker
  ) {
    throw new Error("Mint identity or authority fields changed unexpectedly.");
  }
}

function assertTokenIdentityUnchanged(
  before: TokenAccountInfo,
  after: TokenAccountInfo,
): void {
  if (
    after.mint !== before.mint ||
    after.owner !== before.owner ||
    after.isFrozen !== before.isFrozen
  ) {
    throw new Error("Token account identity or frozen state changed unexpectedly.");
  }
}
