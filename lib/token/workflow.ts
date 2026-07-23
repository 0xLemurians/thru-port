export const TOKEN_CREATION_STAGES = [
  "validating",
  "creating-mint",
  "waiting-mint-finalization",
  "creating-token-account",
  "waiting-account-finalization",
  "minting-initial-supply",
  "verifying-on-chain-state",
  "completed",
] as const;

export type TokenCreationStage = (typeof TOKEN_CREATION_STAGES)[number] | "failed";
export type TokenTransactionKind = "mint" | "token-account" | "initial-supply";

export const TOKEN_CREATION_STAGE_LABELS: Record<TokenCreationStage, string> = {
  validating: "Validating",
  "creating-mint": "Creating mint",
  "waiting-mint-finalization": "Waiting for mint finalization",
  "creating-token-account": "Creating token account",
  "waiting-account-finalization": "Waiting for account finalization",
  "minting-initial-supply": "Minting initial supply",
  "verifying-on-chain-state": "Verifying on-chain state",
  completed: "Completed",
  failed: "Failed",
};

export interface TokenTransactionReceipt {
  signature: string;
}

export interface TokenCreationWorkflowResult {
  mint: TokenTransactionReceipt;
  tokenAccount: TokenTransactionReceipt;
  initialSupply: TokenTransactionReceipt;
}

export interface TokenCreationProgress {
  stage: TokenCreationStage;
  failedAt?: Exclude<TokenCreationStage, "failed">;
  error?: string;
  signature?: string;
  transactionKind?: TokenTransactionKind;
}

type SubmittedCallback = (signature: string) => void;

export interface TokenCreationOperations {
  validate: () => Promise<void>;
  createMint: (onSubmitted: SubmittedCallback) => Promise<TokenTransactionReceipt>;
  createTokenAccount: (
    onSubmitted: SubmittedCallback,
  ) => Promise<TokenTransactionReceipt>;
  mintInitialSupply: (
    onSubmitted: SubmittedCallback,
  ) => Promise<TokenTransactionReceipt>;
  verifyOnChainState: () => Promise<void>;
}

export class TokenCreationWorkflowError extends Error {
  readonly failedAt: Exclude<TokenCreationStage, "failed">;

  constructor(
    failedAt: Exclude<TokenCreationStage, "failed">,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = "TokenCreationWorkflowError";
    this.failedAt = failedAt;
  }
}

export async function runTokenCreationWorkflow(
  operations: TokenCreationOperations,
  onProgress: (progress: TokenCreationProgress) => void,
): Promise<TokenCreationWorkflowResult> {
  let currentStage: Exclude<TokenCreationStage, "failed"> = "validating";
  const progress = (
    stage: Exclude<TokenCreationStage, "failed">,
    details: Omit<TokenCreationProgress, "stage"> = {},
  ) => {
    currentStage = stage;
    onProgress({ stage, ...details });
  };

  try {
    progress("validating");
    await operations.validate();

    progress("creating-mint");
    const mint = await operations.createMint((signature) => {
      progress("waiting-mint-finalization", {
        signature,
        transactionKind: "mint",
      });
    });

    progress("creating-token-account");
    const tokenAccount = await operations.createTokenAccount((signature) => {
      progress("waiting-account-finalization", {
        signature,
        transactionKind: "token-account",
      });
    });

    progress("minting-initial-supply");
    const initialSupply = await operations.mintInitialSupply((signature) => {
      onProgress({
        stage: "minting-initial-supply",
        signature,
        transactionKind: "initial-supply",
      });
    });

    progress("verifying-on-chain-state");
    await operations.verifyOnChainState();

    progress("completed");
    return { mint, tokenAccount, initialSupply };
  } catch (cause) {
    const error = new TokenCreationWorkflowError(currentStage, cause);
    onProgress({
      stage: "failed",
      failedAt: currentStage,
      error: error.message,
    });
    throw error;
  }
}

export const TOKEN_MUTATION_STAGES = [
  "validating",
  "building-transaction",
  "waiting-final-consensus",
  "verifying-execution",
  "refetching-on-chain-state",
  "completed",
] as const;

export type TokenMutationStage =
  | (typeof TOKEN_MUTATION_STAGES)[number]
  | "failed";

export const TOKEN_MUTATION_STAGE_LABELS: Record<TokenMutationStage, string> = {
  validating: "Validating",
  "building-transaction": "Building transaction",
  "waiting-final-consensus": "Waiting for final consensus",
  "verifying-execution": "Verifying execution",
  "refetching-on-chain-state": "Refetching on-chain state",
  completed: "Completed",
  failed: "Failed",
};

export interface TokenMutationProgress {
  stage: TokenMutationStage;
  failedAt?: Exclude<TokenMutationStage, "failed">;
  error?: string;
  signature?: string;
}

export interface TokenMutationExecutionCallbacks {
  onAwaitingFinalConsensus: () => void;
  onSubmitted: (signature: string) => void;
  onFinalConsensus: () => void;
}

export interface TokenMutationOperations<TResult> {
  validate: () => Promise<void>;
  execute: (
    callbacks: TokenMutationExecutionCallbacks,
  ) => Promise<{ signature: string }>;
  refetchAndVerify: () => Promise<TResult>;
}

export class TokenMutationWorkflowError extends Error {
  readonly failedAt: Exclude<TokenMutationStage, "failed">;
  readonly signature?: string;

  constructor(
    failedAt: Exclude<TokenMutationStage, "failed">,
    cause: unknown,
    signature?: string,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = "TokenMutationWorkflowError";
    this.failedAt = failedAt;
    this.signature = signature;
  }
}

export async function runTokenMutationWorkflow<TResult>(
  operations: TokenMutationOperations<TResult>,
  onProgress: (progress: TokenMutationProgress) => void,
): Promise<{ signature: string; result: TResult }> {
  let currentStage: Exclude<TokenMutationStage, "failed"> = "validating";
  let signature: string | undefined;
  const progress = (
    stage: Exclude<TokenMutationStage, "failed">,
    details: Omit<TokenMutationProgress, "stage"> = {},
  ) => {
    currentStage = stage;
    onProgress({ stage, ...details });
  };

  try {
    progress("validating");
    await operations.validate();

    progress("building-transaction");
    const execution = await operations.execute({
      onAwaitingFinalConsensus: () => {
        progress("waiting-final-consensus", { signature });
      },
      onSubmitted: (submittedSignature) => {
        signature = submittedSignature;
        progress("waiting-final-consensus", { signature });
      },
      onFinalConsensus: () => {
        progress("verifying-execution", { signature });
      },
    });
    signature = execution.signature;

    progress("refetching-on-chain-state", { signature });
    const result = await operations.refetchAndVerify();

    progress("completed", { signature });
    return { signature, result };
  } catch (cause) {
    const error = new TokenMutationWorkflowError(
      currentStage,
      cause,
      signature,
    );
    onProgress({
      stage: "failed",
      failedAt: currentStage,
      error: error.message,
      signature,
    });
    throw error;
  }
}
