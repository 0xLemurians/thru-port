import type {
  MintAccountInfo,
  TokenAccountInfo,
} from "@thru/programs/token";

export const TOKEN_RESUME_STAGES = [
  "validating",
  "ensuring-token-account",
  "waiting-account-finalization",
  "minting-initial-supply",
  "waiting-supply-finalization",
  "verifying-on-chain-state",
  "completed",
] as const;

export type TokenResumeStage =
  | (typeof TOKEN_RESUME_STAGES)[number]
  | "failed"
  | "uncertain";

export const TOKEN_RESUME_STAGE_LABELS: Record<TokenResumeStage, string> = {
  validating: "Validating existing mint",
  "ensuring-token-account": "Ensuring token account",
  "waiting-account-finalization": "Waiting for account finalization",
  "minting-initial-supply": "Minting initial supply if needed",
  "waiting-supply-finalization": "Waiting for supply finalization",
  "verifying-on-chain-state": "Verifying on-chain state",
  completed: "Completed",
  failed: "Failed",
  uncertain: "Status unconfirmed",
};

export type TokenResumeTransactionKind = "token-account" | "initial-supply";

export interface TokenResumeProgress {
  stage: TokenResumeStage;
  failedAt?: Exclude<TokenResumeStage, "failed" | "uncertain">;
  uncertainAt?: Exclude<TokenResumeStage, "failed" | "uncertain">;
  signature?: string;
  transactionKind?: TokenResumeTransactionKind;
  error?: string;
  detail?: string;
  expectedStateObserved?: boolean;
}

export interface ResumeTokenSetupPlan {
  createTokenAccount: boolean;
  mintInitialSupply: boolean;
  tokenAccountAlreadyExisted: boolean;
  initialSupplyAlreadyPresent: boolean;
}

export function planTokenSetupResume(input: {
  mintAddress: string;
  ownerAddress: string;
  mint: MintAccountInfo;
  tokenAccount: TokenAccountInfo | null;
}): ResumeTokenSetupPlan {
  const { mintAddress, ownerAddress, mint, tokenAccount } = input;
  if (mint.mintAuthority !== ownerAddress) {
    throw new Error("The active wallet is not this mint's mint authority.");
  }
  if (tokenAccount) {
    if (tokenAccount.mint !== mintAddress) {
      throw new Error("The existing token account belongs to a different mint.");
    }
    if (tokenAccount.owner !== ownerAddress) {
      throw new Error("The existing token account belongs to a different owner.");
    }
    if (tokenAccount.isFrozen) {
      throw new Error("The existing token account is frozen.");
    }
    if (tokenAccount.amount > mint.supply) {
      throw new Error("Token account balance exceeds the mint supply.");
    }
  }

  const initialSupplyAlreadyPresent = mint.supply > 0n;
  if (!initialSupplyAlreadyPresent && tokenAccount?.amount !== undefined) {
    if (tokenAccount.amount !== 0n) {
      throw new Error(
        "Mint supply is zero but the existing token account has a balance.",
      );
    }
  }

  return {
    createTokenAccount: tokenAccount === null,
    mintInitialSupply: !initialSupplyAlreadyPresent,
    tokenAccountAlreadyExisted: tokenAccount !== null,
    initialSupplyAlreadyPresent,
  };
}
