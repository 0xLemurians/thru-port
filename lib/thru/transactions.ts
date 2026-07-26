import {
  ConsensusStatus,
  type BuildTransactionOptions,
  type Transaction,
} from "@thru/sdk";
import { thru } from "./client";

const MAX_CHAIN_ID = 0xffff;
export const TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS = 45_000;
export const SAFE_TRANSACTION_UNCERTAIN_MESSAGE =
  "The transaction was submitted, but final confirmation is still unavailable. Check the Explorer before trying again.";

export interface TransactionExecutionResultLike {
  vmError: number;
  userErrorCode: bigint;
  executionResult?: bigint;
}

export interface FinalizedTransactionLike {
  executionResult?: TransactionExecutionResultLike;
}

export type SubmittedTransactionVerificationResult =
  | {
      outcome: "success";
      source: "finalized-transaction" | "post-state";
    }
  | {
      outcome: "failure";
      source: "finalized-transaction" | "post-state";
    };

export class SubmittedTransactionUncertainError extends Error {
  readonly signature: string;
  readonly expectedStateObserved: boolean;

  constructor(signature: string, expectedStateObserved = false) {
    super(SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
    this.name = "SubmittedTransactionUncertainError";
    this.signature = signature;
    this.expectedStateObserved = expectedStateObserved;
  }
}

export interface VerifySubmittedTransactionOptions {
  signature: string;
  readFinalizedTransaction?: () => Promise<FinalizedTransactionLike>;
  verifyExpectedState?: () => Promise<boolean>;
  classifyExpectedStateError?: (
    error: unknown,
  ) => "pending" | "failure";
  signal?: AbortSignal;
  timeoutMs?: number;
  initialBackoffMs?: number;
  maximumBackoffMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function assertUsableTransactionContext(
  transaction: Pick<Transaction, "chainId" | "startSlot">,
): void {
  if (
    !Number.isInteger(transaction.chainId) ||
    transaction.chainId <= 0 ||
    transaction.chainId > MAX_CHAIN_ID
  ) {
    throw new Error("The current AlphaNet chain ID is unavailable.");
  }
  if (
    typeof transaction.startSlot !== "bigint" ||
    transaction.startSlot <= 0n
  ) {
    throw new Error("The current AlphaNet finalized slot is unavailable.");
  }
}

/**
 * @thru/sdk 0.3.0 fetches the fee-payer nonce, finalized slot, and chain ID
 * while building. The result is checked before it may reach a signing call.
 */
export async function buildTransactionForSigning(
  options: BuildTransactionOptions,
  signal?: AbortSignal,
  build: (
    options: BuildTransactionOptions,
  ) => Promise<Transaction> = (input) => thru.transactions.build(input),
): Promise<Transaction> {
  throwIfAborted(signal);
  const transaction = await build(options);
  throwIfAborted(signal);
  assertUsableTransactionContext(transaction);
  return transaction;
}

/**
 * Signs only through the official SDK Transaction API. An abort that occurs
 * while the local signing promise is settling prevents later serialization or
 * submission.
 */
export async function signTransactionForSubmission(
  transaction: { sign(privateKey: Uint8Array): Promise<unknown> },
  privateKey: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await transaction.sign(privateKey);
  throwIfAborted(signal);
}

/**
 * Account creation uses the SDK's specialized proof builder, which does not
 * fetch chain ID itself. Resolve and validate it freshly for every attempt.
 */
export async function readFreshChainId(
  signal?: AbortSignal,
  readChainId: () => Promise<number> = () => thru.chain.getChainId(),
): Promise<number> {
  throwIfAborted(signal);
  const chainId = await readChainId();
  throwIfAborted(signal);
  if (
    !Number.isInteger(chainId) ||
    chainId <= 0 ||
    chainId > MAX_CHAIN_ID
  ) {
    throw new Error("The current AlphaNet chain ID is unavailable.");
  }
  return chainId;
}

function executionFailed(result: TransactionExecutionResultLike): boolean {
  return (
    result.vmError !== 0 ||
    result.userErrorCode !== 0n ||
    (result.executionResult !== undefined && result.executionResult !== 0n)
  );
}

function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves an already-submitted transaction using read-only evidence only.
 * This helper never builds, signs, serializes, sends, retries, or rebroadcasts.
 */
export async function verifySubmittedTransaction(
  options: VerifySubmittedTransactionOptions,
): Promise<SubmittedTransactionVerificationResult> {
  const {
    signature,
    readFinalizedTransaction = () =>
      thru.transactions.get(signature, {
        minConsensus: ConsensusStatus.FINALIZED,
      }),
    verifyExpectedState,
    classifyExpectedStateError = () => "pending",
    signal,
    timeoutMs = TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS,
    initialBackoffMs = 250,
    maximumBackoffMs = 4_000,
    now = Date.now,
    sleep = abortableDelay,
  } = options;
  if (!signature) {
    throw new Error("A submitted transaction signature is required.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SubmittedTransactionUncertainError(signature);
  }

  const startedAt = now();
  let attempt = 0;
  let expectedStateObserved = false;
  while (true) {
    throwIfAborted(signal);
    try {
      const finalizedTransaction = await readFinalizedTransaction();
      throwIfAborted(signal);
      if (finalizedTransaction.executionResult) {
        return executionFailed(finalizedTransaction.executionResult)
          ? { outcome: "failure", source: "finalized-transaction" }
          : { outcome: "success", source: "finalized-transaction" };
      }
    } catch {
      throwIfAborted(signal);
    }

    if (verifyExpectedState) {
      try {
        expectedStateObserved = await verifyExpectedState();
        throwIfAborted(signal);
        if (expectedStateObserved) {
          return { outcome: "success", source: "post-state" };
        }
      } catch (error) {
        throwIfAborted(signal);
        if (classifyExpectedStateError(error) === "failure") {
          return { outcome: "failure", source: "post-state" };
        }
      }
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new SubmittedTransactionUncertainError(
        signature,
        expectedStateObserved,
      );
    }

    const backoffMs = Math.min(
      initialBackoffMs * 2 ** attempt,
      maximumBackoffMs,
      timeoutMs - elapsedMs,
    );
    await sleep(backoffMs, signal);
    attempt += 1;
  }
}
