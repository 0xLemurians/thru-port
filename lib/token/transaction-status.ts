import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionUncertainError,
  TransactionDeadlineExceededError,
  createTransactionDeadline,
  transactionExecutionOutcome,
} from "../thru/transactions";

export const TRANSACTION_VISIBILITY_TIMEOUT_MS = 45_000;

export interface TransactionExecutionResultLike {
  vmError: number;
  userErrorCode: bigint;
  executionResult?: bigint;
  errorProgramAccIdx?: number;
}

export interface TransactionStatusLike {
  statusCode?: number;
  executionResult?: TransactionExecutionResultLike;
}

export interface TransactionVisibilityResult<TStatus> {
  status?: TStatus;
  expectedStateObserved: boolean;
  source: "transaction-status" | "post-state";
}

export class TransactionStatusUncertainError
  extends SubmittedTransactionUncertainError {
  constructor(signature: string, expectedStateObserved: boolean) {
    super(signature, expectedStateObserved);
    this.name = "TransactionStatusUncertainError";
  }
}

export interface WaitForTransactionVisibilityOptions<
  TStatus extends TransactionStatusLike,
> {
  signature: string;
  readStatus: () => Promise<TStatus>;
  isFinalConsensus: (status: number) => boolean;
  assertExecutionSucceeded: (
    execution: TransactionExecutionResultLike,
  ) => boolean;
  verifyExpectedState?: () => Promise<boolean>;
  onFinalConsensus?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  initialBackoffMs?: number;
  maximumBackoffMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export async function waitForTransactionVisibility<
  TStatus extends TransactionStatusLike,
>(
  options: WaitForTransactionVisibilityOptions<TStatus>,
): Promise<TransactionVisibilityResult<TStatus>> {
  const {
    signature,
    readStatus,
    isFinalConsensus,
    assertExecutionSucceeded,
    verifyExpectedState,
    onFinalConsensus,
    signal,
    timeoutMs = TRANSACTION_VISIBILITY_TIMEOUT_MS,
    initialBackoffMs = 250,
    maximumBackoffMs = 4_000,
    now = Date.now,
    sleep = abortableDelay,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TransactionStatusUncertainError(signature, false);
  }
  const deadline = createTransactionDeadline(timeoutMs, now);
  let attempt = 0;
  let expectedStateObserved = false;

  while (true) {
    signal?.throwIfAborted();
    let status: TStatus | undefined;
    try {
      status = await deadline.run(readStatus, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof TransactionDeadlineExceededError) {
        throw new TransactionStatusUncertainError(signature, expectedStateObserved);
      }
      if (!isTransactionNotFoundError(error)) throw error;
    }

    if (status?.executionResult && transactionExecutionOutcome(status.executionResult) !== "unknown") {
      if (transactionExecutionOutcome(status.executionResult) === "failure" &&
          status.statusCode !== undefined && isFinalConsensus(status.statusCode)) {
        // Keep a caller's typed execution error if its assertion throws, but a
        // boolean false must not fall through to conflicting post-state success.
        assertExecutionSucceeded(status.executionResult);
        throw new Error("Transaction execution failed.");
      }
      const executionSucceeded = assertExecutionSucceeded(
        status.executionResult,
      );
      if (
        executionSucceeded &&
        status.statusCode !== undefined &&
        isFinalConsensus(status.statusCode)
      ) {
        onFinalConsensus?.();
        return {
          status,
          expectedStateObserved,
          source: "transaction-status",
        };
      }
    }

    if (verifyExpectedState) {
      try { expectedStateObserved = await deadline.run(verifyExpectedState, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TransactionDeadlineExceededError) {
          throw new TransactionStatusUncertainError(signature, expectedStateObserved);
        }
        throw error;
      }
      if (expectedStateObserved) {
        return {
          status,
          expectedStateObserved,
          source: "post-state",
        };
      }
    }

    if (deadline.remainingMs() <= 0) {
      throw new TransactionStatusUncertainError(
        signature,
        expectedStateObserved,
      );
    }

    const backoffMs = Math.min(
      initialBackoffMs * 2 ** attempt,
      maximumBackoffMs,
      deadline.remainingMs(),
    );
    try { await deadline.run(() => sleep(backoffMs, signal), signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TransactionDeadlineExceededError)) throw error;
      throw new TransactionStatusUncertainError(signature, expectedStateObserved);
    }
    attempt += 1;
  }
}

export function isTransactionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error as { code?: number } | null)?.code === 5 ||
    /\bnot[_ -]?found\b/i.test(message) ||
    /transaction\s+not\s+found/i.test(message)
  );
}

export { SAFE_TRANSACTION_UNCERTAIN_MESSAGE };

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
