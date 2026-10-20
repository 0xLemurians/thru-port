import {
  ConsensusStatus,
  Signature,
  type Account,
  type BuildTransactionOptions,
  type Transaction,
} from "@thru/sdk";
import { thru } from "./client";
import { THRU_NETWORK } from "./network";
import { reserveGuardedSubmission } from "./write-operation-guard";

const MAX_CHAIN_ID = 0xffff;
const FINAL_ACCOUNT_CONSENSUS = new Set<ConsensusStatus>([
  ConsensusStatus.FINALIZED,
  ConsensusStatus.CLUSTER_EXECUTED,
]);
const READABLE_ACCOUNT_CONSENSUS = new Set<ConsensusStatus>([
  ConsensusStatus.INCLUDED,
  ...FINAL_ACCOUNT_CONSENSUS,
]);
export const TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS = 45_000;
export const SAFE_TRANSACTION_UNCERTAIN_MESSAGE =
  "The transaction was submitted, but final confirmation is still unavailable. Check the Explorer before trying again.";
export const TRANSACTION_STATUS_POLL_INTERVAL_MS = 2_000;

export type TransactionSubmissionStage =
  | "faucet-preflight"
  | "account-lookup"
  | "account-create-build"
  | "account-create-sign"
  | "account-create-submit"
  | "account-create-status"
  | "account-create-post-state"
  | "faucet-build"
  | "faucet-sign"
  | "faucet-submit"
  | "faucet-status"
  | "submit"
  | "status";

export interface SafeTransactionDiagnostic {
  stage: TransactionSubmissionStage;
  state: "started" | "succeeded" | "failed" | "uncertain";
  signature: string;
  consensusStatus?: ConsensusStatus;
  vmError?: number;
  userErrorCode?: bigint;
  error?: unknown;
}

export interface TransactionStatusLike {
  signature: Uint8Array;
  statusCode?: ConsensusStatus;
  executionResult?: TransactionExecutionResultLike;
}

export interface SubmitSignedTransactionOnceOptions {
  rawTransaction: Uint8Array;
  expectedSignature: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cancels read-only observation only; submission is never cancelled or repeated. */
  pollingSignal?: AbortSignal;
  pollIntervalMs?: number;
  send?: (rawTransaction: Uint8Array) => Promise<string>;
  getStatus?: (signature: string) => Promise<TransactionStatusLike>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onDiagnostic?: (diagnostic: SafeTransactionDiagnostic) => void;
}

export interface SubmittedTransactionStatusResult {
  signature: string;
  executionSucceeded: boolean;
  finalized: boolean;
  statusTimedOut: boolean;
  failure?: {
    vmError: number;
    userErrorCode: bigint;
  };
}

export interface TransactionExecutionResultLike {
  vmError: number;
  userErrorCode: bigint;
  executionResult?: bigint;
}

export interface FinalizedTransactionLike {
  getSignature(): Signature | undefined;
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

/** An invalid response identity cannot authorize execution or post-state success. */
export class SubmittedTransactionIdentityError extends SubmittedTransactionUncertainError {
  constructor(signature: string) {
    super(signature);
    this.name = "SubmittedTransactionIdentityError";
  }
}

function assertFinalizedTransactionIdentity(
  transaction: FinalizedTransactionLike,
  expected: Signature,
  originalSignature: string,
): void {
  try {
    const returned = transaction?.getSignature();
    if (returned instanceof Signature) {
      // Copy and reparse through the official SDK, rather than trusting an
      // arbitrary signature property or an overridden equals() implementation.
      const canonical = Signature.from(returned.toBytes());
      if (canonical.toBytes().some((byte) => byte !== 0) && expected.equals(canonical)) return;
    }
  } catch {
    // Missing/throwing methods and malformed SDK-shaped values fail closed.
  }
  throw new SubmittedTransactionIdentityError(originalSignature);
}

export class AccountConsensusPendingError extends Error {
  constructor() {
    super("The requested account state is not finalized yet.");
    this.name = "AccountConsensusPendingError";
  }
}

export type AccountReadFinality = "provisional" | "finalized";

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

export class TransactionDeadlineExceededError extends Error {
  constructor() {
    super("Transaction verification timed out.");
    this.name = "TransactionDeadlineExceededError";
  }
}

/** One phase budget, including time spent inside RPC promises and delays. */
export function createTransactionDeadline(timeoutMs: number, now = Date.now) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TransactionDeadlineExceededError();
  }
  const startedAt = now();
  const monotonicStartedAt = performance.now();
  let elapsed = 0;
  let expired = false;
  const remainingMs = () => {
    // Millisecond precision matches existing injected clocks/backoff contracts;
    // fractional performance timestamps must not create extra sub-ms polls.
    elapsed = Math.max(elapsed, now() - startedAt, Math.floor(performance.now() - monotonicStartedAt));
    return expired ? 0 : Math.max(0, timeoutMs - elapsed);
  };
  return {
    remainingMs,
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const remaining = remainingMs();
        // Preserve an immediate final observation exactly at the deadline, but
        // never let it wait beyond that boundary or restart the phase budget.
        if (expired || elapsed > timeoutMs) {
          reject(new TransactionDeadlineExceededError());
          return;
        }
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => {
          expired = true;
          fail(new TransactionDeadlineExceededError());
        }, remaining);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        try {
          Promise.resolve(work()).then((value) => {
            if (settled) return;
            remainingMs();
            if (expired || elapsed > timeoutMs) {
              fail(new TransactionDeadlineExceededError());
              return;
            }
            settled = true;
            cleanup();
            resolve(value);
          }, fail);
        } catch (error) { fail(error); }
      });
    },
  };
}

/**
 * SDK 0.4.1 returns consensus metadata on point account reads instead of
 * accepting minConsensus in AccountQueryOptions. Final-state callers fail
 * closed until the returned account version is finalized/cluster-executed.
 */
export function assertFinalizedAccount(
  account: Pick<Account, "consensusStatus">,
): void {
  if (
    account.consensusStatus === undefined ||
    !FINAL_ACCOUNT_CONSENSUS.has(account.consensusStatus)
  ) {
    throw new AccountConsensusPendingError();
  }
}

/**
 * Normal read-only surfaces may display the current INCLUDED ledger version,
 * but callers can still distinguish it from authoritative final state. This
 * policy must never be used to prove a submitted transaction succeeded.
 */
export function accountReadFinality(
  account: Pick<Account, "consensusStatus">,
): AccountReadFinality {
  if (
    account.consensusStatus === undefined ||
    !READABLE_ACCOUNT_CONSENSUS.has(account.consensusStatus)
  ) {
    throw new AccountConsensusPendingError();
  }
  return FINAL_ACCOUNT_CONSENSUS.has(account.consensusStatus)
    ? "finalized"
    : "provisional";
}

export function assertExplicitTransactionResources(
  options: Pick<BuildTransactionOptions, "header">,
): void {
  const computeUnits = options.header?.computeUnits;
  const stateUnits = options.header?.stateUnits;
  const memoryUnits = options.header?.memoryUnits;
  if (!Number.isSafeInteger(computeUnits) || (computeUnits ?? 0) <= 0) {
    throw new Error("Transaction compute units must be explicitly greater than zero.");
  }
  if (!Number.isSafeInteger(memoryUnits) || (memoryUnits ?? 0) <= 0) {
    throw new Error("Transaction memory units must be explicitly greater than zero.");
  }
  // Some official v0.4.1 builders, including faucet withdraw, explicitly use
  // zero state units. Missing or negative values still fail closed.
  if (!Number.isSafeInteger(stateUnits) || (stateUnits ?? -1) < 0) {
    throw new Error("Transaction state units must be explicitly non-negative.");
  }
}

export function assertUsableTransactionContext(
  transaction: Pick<Transaction, "chainId" | "startSlot">,
): void {
  if (
    !Number.isInteger(transaction.chainId) ||
    transaction.chainId <= 0 ||
    transaction.chainId > MAX_CHAIN_ID
  ) {
    throw new Error(`The current ${THRU_NETWORK.displayName} chain ID is unavailable.`);
  }
  if (transaction.chainId !== THRU_NETWORK.expectedChainId) {
    throw new Error(
      `The RPC chain ID does not match ${THRU_NETWORK.displayName}.`,
    );
  }
  if (
    typeof transaction.startSlot !== "bigint" ||
    transaction.startSlot <= 0n
  ) {
    throw new Error(`The current ${THRU_NETWORK.displayName} finalized slot is unavailable.`);
  }
}

/**
 * @thru/sdk 0.4.1 fetches the fee-payer nonce, finalized slot, and chain ID
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
  assertExplicitTransactionResources(options);
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

export function transactionExecutionOutcome(result: unknown): "success" | "failure" | "unknown" {
  if (!result || typeof result !== "object") return "unknown";
  const { vmError, userErrorCode, executionResult } = result as Partial<TransactionExecutionResultLike>;
  const uint64 = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= 0xffff_ffff_ffff_ffffn;
  // SDK VM errors are a signed protobuf enum, including negative error codes.
  if (typeof vmError !== "number" || !Number.isSafeInteger(vmError) ||
      vmError < -0x8000_0000 || vmError > 0x7fff_ffff || !uint64(userErrorCode) ||
      (executionResult !== undefined && !uint64(executionResult))) return "unknown";
  return vmError !== 0 || userErrorCode !== 0n ||
    (executionResult !== undefined && executionResult !== 0n) ? "failure" : "success";
}

export function reportSafeTransactionDiagnostic(
  callback: SubmitSignedTransactionOnceOptions["onDiagnostic"],
  diagnostic: SafeTransactionDiagnostic,
): void {
  try {
    callback?.(diagnostic);
  } catch {
    // Optional diagnostics must never change transaction behavior.
  }
}

export async function runTransactionDiagnosticStage<T>(
  stage: TransactionSubmissionStage,
  callback: SubmitSignedTransactionOnceOptions["onDiagnostic"],
  work: () => Promise<T>,
  signature = "",
): Promise<T> {
  reportSafeTransactionDiagnostic(callback, {
    stage,
    state: "started",
    signature,
  });
  try {
    const result = await work();
    reportSafeTransactionDiagnostic(callback, {
      stage,
      state: "succeeded",
      signature,
    });
    return result;
  } catch (error) {
    reportSafeTransactionDiagnostic(callback, {
      stage,
      state: "failed",
      signature,
      error,
    });
    throw error;
  }
}

/**
 * Submits an already signed transaction exactly once through the unary SDK
 * endpoint, then observes it through read-only status polling. This mirrors
 * the browser-safe Betanet reference flow and deliberately never rebuilds,
 * re-signs, retries, or rebroadcasts after submission starts.
 */
export async function submitSignedTransactionOnce(
  options: SubmitSignedTransactionOnceOptions,
): Promise<SubmittedTransactionStatusResult> {
  const {
    rawTransaction,
    expectedSignature,
    signal,
    pollingSignal,
    timeoutMs = 30_000,
    pollIntervalMs = TRANSACTION_STATUS_POLL_INTERVAL_MS,
    send = (raw) => thru.transactions.send(raw),
    getStatus = (signature) => thru.transactions.getStatus(signature),
    now = Date.now,
    sleep = (delayMs) => abortableDelay(delayMs, pollingSignal),
    onDiagnostic,
  } = options;

  if (!expectedSignature) {
    throw new Error("A signed transaction signature is required before submission.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Transaction status timeout must be greater than zero.");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Transaction status poll interval must be greater than zero.");
  }

  throwIfAborted(signal);
  const deadline = createTransactionDeadline(timeoutMs, now);
  const releaseFence = reserveGuardedSubmission(rawTransaction, expectedSignature);
  reportSafeTransactionDiagnostic(onDiagnostic, {
    stage: "submit",
    state: "started",
    signature: expectedSignature,
  });

  let returnedSignature: string;
  let sendStarted = false;
  try {
    // No AbortSignal is attached once this unary RPC starts: cancellation
    // cannot safely imply that the signed transaction was not accepted.
    returnedSignature = await deadline.run(() => {
      throwIfAborted(signal);
      if (deadline.remainingMs() <= 0) throw new TransactionDeadlineExceededError();
      sendStarted = true;
      return send(rawTransaction);
    });
  } catch (error) {
    reportSafeTransactionDiagnostic(onDiagnostic, {
      stage: "submit",
      state: sendStarted ? "uncertain" : "failed",
      signature: expectedSignature,
      error,
    });
    if (!sendStarted) {
      // Only this newly reserved fence can be released: the unary boundary was
      // never entered. Existing unresolved fences are rejected by reservation.
      releaseFence?.();
      throw error;
    }
    throw new SubmittedTransactionUncertainError(expectedSignature);
  }

  if (returnedSignature !== expectedSignature) {
    const error = new Error(
      "The submitted transaction signature does not match the signed transaction.",
    );
    reportSafeTransactionDiagnostic(onDiagnostic, {
      stage: "submit",
      state: "failed",
      signature: expectedSignature,
      error,
    });
    // Submission has already happened; fail closed without allowing a retry.
    throw new SubmittedTransactionUncertainError(expectedSignature);
  }
  reportSafeTransactionDiagnostic(onDiagnostic, {
    stage: "submit",
    state: "succeeded",
    signature: expectedSignature,
  });

  while (deadline.remainingMs() > 0) {
    if (pollingSignal?.aborted) break;
    reportSafeTransactionDiagnostic(onDiagnostic, {
      stage: "status",
      state: "started",
      signature: expectedSignature,
    });
    let status: TransactionStatusLike;
    try {
      status = await deadline.run(() => getStatus(expectedSignature), pollingSignal);
    } catch (error) {
      reportSafeTransactionDiagnostic(onDiagnostic, {
        stage: "status",
        state: "uncertain",
        signature: expectedSignature,
        error,
      });
      const remainingMs = deadline.remainingMs();
      if (remainingMs <= 0) break;
      if (pollingSignal?.aborted) break;
      try { await deadline.run(() => sleep(Math.min(pollIntervalMs, remainingMs)), pollingSignal); }
      catch { break; }
      continue;
    }

    let statusSignature: string;
    try {
      statusSignature = Signature.from(status.signature).toThruFmt();
    } catch (error) {
      reportSafeTransactionDiagnostic(onDiagnostic, {
        stage: "status",
        state: "failed",
        signature: expectedSignature,
        error,
      });
      throw new SubmittedTransactionUncertainError(expectedSignature);
    }
    if (statusSignature !== expectedSignature) {
      const error = new Error(
        "The transaction status signature does not match the submitted transaction.",
      );
      reportSafeTransactionDiagnostic(onDiagnostic, {
        stage: "status",
        state: "failed",
        signature: expectedSignature,
        error,
      });
      throw new SubmittedTransactionUncertainError(expectedSignature);
    }

    const outcome = transactionExecutionOutcome(status.executionResult);
    if (status.executionResult && outcome === "failure") {
      const { vmError, userErrorCode } = status.executionResult;
      if (status.statusCode === ConsensusStatus.FINALIZED || status.statusCode === ConsensusStatus.CLUSTER_EXECUTED) releaseFence?.();
      reportSafeTransactionDiagnostic(onDiagnostic, {
        stage: "status",
        state: "failed",
        signature: expectedSignature,
        consensusStatus: status.statusCode,
        vmError,
        userErrorCode,
      });
      return {
        signature: expectedSignature,
        executionSucceeded: false,
        finalized: false,
        statusTimedOut: false,
        failure: { vmError, userErrorCode },
      };
    }

    const finalized =
      status.statusCode === ConsensusStatus.FINALIZED ||
      status.statusCode === ConsensusStatus.CLUSTER_EXECUTED;
    const executionSucceeded = finalized && outcome === "success";
    reportSafeTransactionDiagnostic(onDiagnostic, {
      stage: "status",
      state: finalized && executionSucceeded ? "succeeded" : "uncertain",
      signature: expectedSignature,
      consensusStatus: status.statusCode,
      vmError: status.executionResult?.vmError,
      userErrorCode: status.executionResult?.userErrorCode,
    });
    if (finalized && executionSucceeded) {
      releaseFence?.();
      return {
        signature: expectedSignature,
        executionSucceeded: true,
        finalized: true,
        statusTimedOut: false,
      };
    }
    if (finalized) {
      // The status endpoint may omit execution details. Hand off immediately
      // to the existing finalized transaction/post-state verifier instead of
      // waiting out the polling deadline.
      return {
        signature: expectedSignature,
        executionSucceeded: false,
        finalized: false,
        statusTimedOut: false,
      };
    }

    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) break;
    try { await deadline.run(() => sleep(Math.min(pollIntervalMs, remainingMs)), pollingSignal); }
    catch { break; }
  }

  reportSafeTransactionDiagnostic(onDiagnostic, {
    stage: "status",
    state: "uncertain",
    signature: expectedSignature,
    error: new Error("Transaction status polling timed out."),
  });

  return {
    signature: expectedSignature,
    executionSucceeded: false,
    finalized: false,
    statusTimedOut: true,
  };
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

  let expectedSignature: Signature;
  try {
    expectedSignature = Signature.from(signature);
    if (!expectedSignature.toBytes().some((byte) => byte !== 0)) {
      throw new Error("Missing transaction signature.");
    }
  } catch {
    throw new SubmittedTransactionIdentityError(signature);
  }

  const deadline = createTransactionDeadline(timeoutMs, now);
  let attempt = 0;
  let expectedStateObserved = false;
  while (true) {
    throwIfAborted(signal);
    try {
      const finalizedTransaction = await deadline.run(readFinalizedTransaction, signal);
      throwIfAborted(signal);
      assertFinalizedTransactionIdentity(finalizedTransaction, expectedSignature, signature);
      const outcome = transactionExecutionOutcome(finalizedTransaction.executionResult);
      if (outcome !== "unknown") {
        return outcome === "failure"
          ? { outcome: "failure", source: "finalized-transaction" }
          : { outcome: "success", source: "finalized-transaction" };
      }
    } catch (error) {
      throwIfAborted(signal);
      // Identity conflicts are not transport failures: never let a conflicting
      // response fall through to success-shaped post-state or release a fence.
      if (error instanceof SubmittedTransactionIdentityError) throw error;
      if (error instanceof TransactionDeadlineExceededError) {
        throw new SubmittedTransactionUncertainError(signature, expectedStateObserved);
      }
    }

    if (verifyExpectedState) {
      try {
        expectedStateObserved = await deadline.run(verifyExpectedState, signal);
        throwIfAborted(signal);
        if (expectedStateObserved) {
          return { outcome: "success", source: "post-state" };
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof TransactionDeadlineExceededError) {
          throw new SubmittedTransactionUncertainError(signature, expectedStateObserved);
        }
        if (classifyExpectedStateError(error) === "failure") {
          return { outcome: "failure", source: "post-state" };
        }
      }
    }

    if (deadline.remainingMs() <= 0) {
      throw new SubmittedTransactionUncertainError(
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
      throwIfAborted(signal);
      if (!(error instanceof TransactionDeadlineExceededError)) throw error;
      throw new SubmittedTransactionUncertainError(signature, expectedStateObserved);
    }
    attempt += 1;
  }
}
