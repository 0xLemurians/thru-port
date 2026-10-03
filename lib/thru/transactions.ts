import {
  ConsensusStatus,
  type Account,
  type BuildTransactionOptions,
  type Transaction,
} from "@thru/sdk";
import { thru } from "./client";
import { THRU_NETWORK } from "./network";

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
