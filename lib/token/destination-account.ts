import { Pubkey } from "@thru/sdk";
import {
  deriveTokenAccountAddress,
  type InitializeAccountArgs,
  type TokenAccountInfo,
} from "@thru/programs/token";

export const RAW_ZERO_TOKEN_ACCOUNT_SEED_LENGTH = 32;

export interface DestinationTokenAccountPreview {
  mintAddress: string;
  destinationOwnerAddress: string;
  tokenAccountAddress: string;
  tokenAccountBytes: Uint8Array;
  seedBytes: Uint8Array;
}

export interface EnsureDestinationTokenAccountOperations {
  readOptionalTokenAccount: (
    address: string,
  ) => Promise<TokenAccountInfo | null>;
  createTokenAccount: () => Promise<string>;
  readCreatedTokenAccount: (address: string) => Promise<TokenAccountInfo>;
}

export interface EnsureDestinationTokenAccountResult {
  tokenAccount: TokenAccountInfo;
  created: boolean;
  signature?: string;
  existenceChecks: number;
}

export function deriveDestinationTokenAccount(
  thruClient: Parameters<typeof deriveTokenAccountAddress>[0],
  input: {
    mintAddress: string;
    destinationOwnerAddress: string;
    tokenProgramAddress: string;
  },
): DestinationTokenAccountPreview {
  const mintAddress = canonicalAddress(input.mintAddress, "Mint address");
  const destinationOwnerAddress = canonicalAddress(
    input.destinationOwnerAddress,
    "Destination owner",
  );
  const seedBytes = createRawZeroTokenAccountSeed();
  const derived = deriveTokenAccountAddress(
    thruClient,
    destinationOwnerAddress,
    mintAddress,
    input.tokenProgramAddress,
    seedBytes,
  );
  return {
    mintAddress,
    destinationOwnerAddress,
    tokenAccountAddress: derived.address,
    tokenAccountBytes: derived.bytes,
    seedBytes,
  };
}

export function buildDestinationInitializeAccountArgs(input: {
  preview: DestinationTokenAccountPreview;
  stateProof: Uint8Array;
}): InitializeAccountArgs {
  return {
    tokenAccountBytes: input.preview.tokenAccountBytes,
    mintAccountBytes: Pubkey.from(input.preview.mintAddress).toBytes(),
    ownerAccountBytes: Pubkey.from(
      input.preview.destinationOwnerAddress,
    ).toBytes(),
    seedBytes: input.preview.seedBytes.slice(),
    stateProof: input.stateProof,
  };
}

export function assertOfficialTokenProgramOwnership(
  actualOwner: string | undefined,
  tokenProgramAddress: string,
  address: string,
): void {
  if (actualOwner !== tokenProgramAddress) {
    throw new Error(
      `On-chain account ${address} is not owned by the official Token Program.`,
    );
  }
}

export function assertDestinationTokenAccountIdentity(input: {
  tokenAccount: TokenAccountInfo;
  mintAddress: string;
  destinationOwnerAddress: string;
}): void {
  if (input.tokenAccount.mint !== input.mintAddress) {
    throw new Error(
      "The destination token account belongs to a different mint.",
    );
  }
  if (input.tokenAccount.owner !== input.destinationOwnerAddress) {
    throw new Error(
      "The destination token account belongs to a different owner.",
    );
  }
}

export function assertNewDestinationTokenAccountState(input: {
  tokenAccount: TokenAccountInfo;
  mintAddress: string;
  destinationOwnerAddress: string;
}): void {
  assertDestinationTokenAccountIdentity(input);
  if (input.tokenAccount.amount !== 0n) {
    throw new Error(
      "A newly created destination token account must have a zero balance.",
    );
  }
  if (input.tokenAccount.isFrozen) {
    throw new Error(
      "A newly created destination token account must not be frozen.",
    );
  }
}

export async function ensureDestinationTokenAccount(
  input: {
    tokenAccountAddress: string;
    mintAddress: string;
    destinationOwnerAddress: string;
  },
  operations: EnsureDestinationTokenAccountOperations,
): Promise<EnsureDestinationTokenAccountResult> {
  let existenceChecks = 0;
  const readOptional = async () => {
    existenceChecks += 1;
    return operations.readOptionalTokenAccount(input.tokenAccountAddress);
  };

  const firstExisting = await readOptional();
  if (firstExisting) {
    assertDestinationTokenAccountIdentity({
      tokenAccount: firstExisting,
      mintAddress: input.mintAddress,
      destinationOwnerAddress: input.destinationOwnerAddress,
    });
    return {
      tokenAccount: firstExisting,
      created: false,
      existenceChecks,
    };
  }

  const secondExisting = await readOptional();
  if (secondExisting) {
    assertDestinationTokenAccountIdentity({
      tokenAccount: secondExisting,
      mintAddress: input.mintAddress,
      destinationOwnerAddress: input.destinationOwnerAddress,
    });
    return {
      tokenAccount: secondExisting,
      created: false,
      existenceChecks,
    };
  }

  const signature = await operations.createTokenAccount();
  const createdAccount = await operations.readCreatedTokenAccount(
    input.tokenAccountAddress,
  );
  assertNewDestinationTokenAccountState({
    tokenAccount: createdAccount,
    mintAddress: input.mintAddress,
    destinationOwnerAddress: input.destinationOwnerAddress,
  });
  return {
    tokenAccount: createdAccount,
    created: true,
    signature,
    existenceChecks,
  };
}

function createRawZeroTokenAccountSeed(): Uint8Array {
  return new Uint8Array(RAW_ZERO_TOKEN_ACCOUNT_SEED_LENGTH);
}

function canonicalAddress(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  try {
    return Pubkey.from(normalized).toThruFmt();
  } catch {
    throw new Error(`${label} is not a valid Thru address.`);
  }
}
