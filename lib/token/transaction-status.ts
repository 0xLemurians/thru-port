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
  status: TStatus;
  expectedStateObserved: boolean;
}

export class TransactionStatusUncertainError extends Error {
  readonly signature: string;
  readonly expectedStateObserved: boolean;

  constructor(signature: string, expectedStateObserved: boolean) {
    super("Transaction submitted but final status could not be confirmed");
    this.name = "TransactionStatusUncertainError";
    this.signature = signature;
    this.expectedStateObserved = expectedStateObserved;
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
  const startedAt = now();
  let attempt = 0;
  let expectedStateObserved = false;

  while (true) {
    signal?.throwIfAborted();
    let status: TStatus | undefined;
    try {
      status = await readStatus();
    } catch (error) {
      if (!isTransactionNotFoundError(error)) throw error;
    }

    if (status?.executionResult) {
      const executionSucceeded = assertExecutionSucceeded(
        status.executionResult,
      );
      if (
        executionSucceeded &&
        status.statusCode !== undefined &&
        isFinalConsensus(status.statusCode)
      ) {
        onFinalConsensus?.();
        return { status, expectedStateObserved };
      }
    }

    if (!expectedStateObserved && verifyExpectedState) {
      expectedStateObserved = await verifyExpectedState();
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new TransactionStatusUncertainError(
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

export function isTransactionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error as { code?: number } | null)?.code === 5 ||
    /\bnot[_ -]?found\b/i.test(message) ||
    /transaction\s+not\s+found/i.test(message)
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
