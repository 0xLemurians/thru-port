import { TransactionStatusUncertainError } from "./transaction-status";

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

export type TokenCreationStage =
  | (typeof TOKEN_CREATION_STAGES)[number]
  | "failed"
  | "uncertain";
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
  uncertain: "Status unconfirmed",
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
  failedAt?: Exclude<TokenCreationStage, "failed" | "uncertain">;
  uncertainAt?: Exclude<TokenCreationStage, "failed" | "uncertain">;
  error?: string;
  signature?: string;
  transactionKind?: TokenTransactionKind;
  expectedStateObserved?: boolean;
}

/** Keep incomplete steps unconfirmed when a token workflow stops. */
export function tokenCreationStepState(
  progress: TokenCreationProgress,
  stepIndex: number,
): "done" | "active" | "pending" | "failed" | "uncertain" {
  const stage = progress.stage === "failed"
    ? progress.failedAt ?? "validating"
    : progress.stage === "uncertain"
      ? progress.uncertainAt ?? "validating"
      : progress.stage;
  const currentStep =
    stage === "completed" ? 5
      : stage === "creating-mint" || stage === "waiting-mint-finalization" ? 1
        : stage === "creating-token-account" || stage === "waiting-account-finalization" ? 2
          : stage === "minting-initial-supply" ? 3
            : stage === "verifying-on-chain-state" ? 4 : 0;
  if (stepIndex < currentStep) return "done";
  if (stepIndex > currentStep) return "pending";
  if (progress.stage === "failed") return "failed";
  if (progress.stage === "uncertain") return "uncertain";
  return "active";
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
  readonly failedAt: Exclude<TokenCreationStage, "failed" | "uncertain">;

  constructor(
    failedAt: Exclude<TokenCreationStage, "failed" | "uncertain">,
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
  let currentStage: Exclude<TokenCreationStage, "failed" | "uncertain"> =
    "validating";
  const progress = (
    stage: Exclude<TokenCreationStage, "failed" | "uncertain">,
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
    if (cause instanceof TransactionStatusUncertainError) {
      onProgress({
        stage: "uncertain",
        uncertainAt: currentStage,
        error: cause.message,
        signature: cause.signature,
        expectedStateObserved: cause.expectedStateObserved,
      });
      throw cause;
    }
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
  | "failed"
  | "uncertain";

export const TOKEN_MUTATION_STAGE_LABELS: Record<TokenMutationStage, string> = {
  validating: "Validating",
  "building-transaction": "Building transaction",
  "waiting-final-consensus": "Waiting for final consensus",
  "verifying-execution": "Verifying execution",
  "refetching-on-chain-state": "Refetching on-chain state",
  completed: "Completed",
  failed: "Failed",
  uncertain: "Status unconfirmed",
};

export interface TokenMutationProgress {
  stage: TokenMutationStage;
  failedAt?: Exclude<TokenMutationStage, "failed" | "uncertain">;
  uncertainAt?: Exclude<TokenMutationStage, "failed" | "uncertain">;
  error?: string;
  signature?: string;
  expectedStateObserved?: boolean;
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
  readonly failedAt: Exclude<TokenMutationStage, "failed" | "uncertain">;
  readonly signature?: string;

  constructor(
    failedAt: Exclude<TokenMutationStage, "failed" | "uncertain">,
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
  let currentStage: Exclude<TokenMutationStage, "failed" | "uncertain"> =
    "validating";
  let signature: string | undefined;
  const progress = (
    stage: Exclude<TokenMutationStage, "failed" | "uncertain">,
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
    if (cause instanceof TransactionStatusUncertainError) {
      onProgress({
        stage: "uncertain",
        uncertainAt: currentStage,
        error: cause.message,
        signature: cause.signature,
        expectedStateObserved: cause.expectedStateObserved,
      });
      throw cause;
    }
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
