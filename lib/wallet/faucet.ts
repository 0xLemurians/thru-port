/**
 * Thru Betanet — Faucet withdraw.
 *
 * @thru/sdk (npm) henüz faucet transaction'ı için hazır bir builder
 * sunmuyor. Instruction layout resmi uygulamayla eşleşirken program ve vault
 * adresleri v0.4.1 bootstrap paketinden alınır.
 *
 * Doğrulanan sabitler (kaynak koddan):
 *  - FAUCET_WITHDRAW_LIMIT: 10_000 (faucet.rs:20 — tek işlemdeki üst sınır)
 *  - Instruction encoding (build_faucet_withdraw_instruction, txn_tools.rs:5725):
 *      u32 LE discriminant(=1 için withdraw)
 *      u16 LE faucet_account_idx
 *      u16 LE recipient_account_idx
 *      u64 LE amount
 *    = toplam 16 byte
 *  - Hesap indeksleme (build_faucet_withdraw, txn_tools.rs:4495):
 *    0 = fee payer, 1 = program (örtük), 2+ = eklenen read-write hesaplar.
 *    Bizim akışımızda kullanıcı KENDİ hesabına çekiyor (recipient == fee payer),
 *    bu da Rust'taki "recipient_is_fee_payer" dalına denk gelir:
 *    yalnızca faucet hazine hesabı rw olarak eklenir → idx 2, recipient idx 0.
 */

import { ConsensusStatus, Signature, type Account } from "@thru/sdk";
import {
  BOOTSTRAP_FAUCET_VAULT_ADDRESS,
  BOOTSTRAP_PROGRAM_ADDRESSES,
} from "@thru/programs/bootstrap-addresses";
import { programResources } from "@thru/programs/resources";
import {
  accountReadFinality,
  buildTransactionForSigning,
  signTransactionForSubmission,
  SubmittedTransactionUncertainError,
  TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS,
  verifySubmittedTransaction,
} from "../thru/transactions";
import { thru, type ThruAccount, getBalance, ensureAccountExists } from "./thru-wallet";
import {
  SAFE_FAUCET_ERROR_MESSAGE,
  SAFE_FAUCET_UNAVAILABLE_MESSAGE,
  SAFE_FAUCET_UNCERTAIN_MESSAGE,
} from "./faucet-safety";

export const FAUCET_ACCOUNT_ADDRESS = BOOTSTRAP_FAUCET_VAULT_ADDRESS;
export const FAUCET_PROGRAM_ADDRESS = BOOTSTRAP_PROGRAM_ADDRESSES.faucet;

export const FAUCET_WITHDRAW_LIMIT = 10_000n;
export const FAUCET_TRANSACTION_RESOURCES = Object.freeze(
  programResources({
    computeUnits: 300_000,
    stateUnits: 0,
    memoryUnits: 10_000,
  }),
);

export function buildFaucetWithdrawInstruction(
  faucetAccountIdx: number,
  recipientAccountIdx: number,
  amount: bigint,
): Uint8Array {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 1, true); // TN_FAUCET_INSTRUCTION_WITHDRAW = 1
  view.setUint16(4, faucetAccountIdx, true);
  view.setUint16(6, recipientAccountIdx, true);
  view.setBigUint64(8, amount, true);
  return buf;
}

export interface FaucetWithdrawResult {
  signature: string;
  finalized: boolean;
  failureReason?: string;
  attempts: number;
}

export class FaucetUnavailableError extends Error {
  constructor() {
    super(SAFE_FAUCET_UNAVAILABLE_MESSAGE);
    this.name = "FaucetUnavailableError";
  }
}

/**
 * The v0.4.1 vault address is a PDA created by faucet initialization, not a
 * genesis account. Fail closed when the current deployment has no matching
 * program-owned vault so no transaction can be prepared for a guessed target.
 */
export async function assertFaucetDeploymentAvailable(
  readAccount: (address: string) => Promise<Account> = (address) =>
    thru.accounts.get(address),
  signal?: AbortSignal,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    const program = await readAccount(FAUCET_PROGRAM_ADDRESS);
    signal?.throwIfAborted();
    accountReadFinality(program);
    if (program.meta?.flags.isDeleted || !program.meta?.flags.isProgram) {
      throw new FaucetUnavailableError();
    }

    const vault = await readAccount(FAUCET_ACCOUNT_ADDRESS);
    signal?.throwIfAborted();
    accountReadFinality(vault);
    if (
      vault.meta?.flags.isDeleted ||
      vault.meta?.owner?.toThruFmt() !== FAUCET_PROGRAM_ADDRESS ||
      (vault.meta?.balance ?? 0n) <= 0n
    ) {
      throw new FaucetUnavailableError();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FaucetUnavailableError();
  }
}

/**
 * Kendi hesabına faucet'ten test token çeker (self-withdraw). Belirsiz veya
 * başarısız bir sonuç otomatik olarak yeniden gönderilmez; kullanıcı ancak
 * güncel ağ sağlığı Online olduğunda elle tekrar deneyebilir.
 */
export async function withdrawFromFaucet(
  account: ThruAccount,
  amount: bigint = FAUCET_WITHDRAW_LIMIT,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FaucetWithdrawResult> {
  const { timeoutMs = 30_000, signal } = options;
  signal?.throwIfAborted();

  if (amount <= 0n) {
    throw new Error("Withdraw amount must be greater than 0.");
  }
  if (amount > FAUCET_WITHDRAW_LIMIT) {
    throw new Error(
      `Faucet withdraw limit is ${FAUCET_WITHDRAW_LIMIT} per transaction.`,
    );
  }

  try {
    await assertFaucetDeploymentAvailable(undefined, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      signature: "",
      finalized: false,
      failureReason: SAFE_FAUCET_UNAVAILABLE_MESSAGE,
      attempts: 0,
    };
  }

  // Yeni bir keypair henüz zincirde "hesap" olarak var olmayabilir —
  // faucet withdraw denemeden önce bunu garantiye alıyoruz.
  try {
    await ensureAccountExists(account, { timeoutMs, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof SubmittedTransactionUncertainError) {
      return {
        signature: error.signature,
        finalized: false,
        failureReason: SAFE_FAUCET_UNCERTAIN_MESSAGE,
        attempts: 0,
      };
    }
    throw new Error(SAFE_FAUCET_ERROR_MESSAGE);
  }

  signal?.throwIfAborted();
  const balanceBefore = await getBalance(account.address);
  try {
    const result = await attemptFaucetWithdraw(
      account,
      amount,
      timeoutMs,
      signal,
    );
    if (result.failureReason) {
      return {
        ...result,
        failureReason: SAFE_FAUCET_ERROR_MESSAGE,
        attempts: 1,
      };
    }
    // A finalized, successful execution result is transaction-specific and
    // is stronger evidence than a generic balance movement.
    if (result.finalized) {
      return {
        signature: result.signature,
        finalized: true,
        attempts: 1,
      };
    }

    let postStateConfirmed = false;
    if (!result.finalized && result.signature) {
      try {
        const verification = await verifySubmittedTransaction({
          signature: result.signature,
          verifyExpectedState: async () =>
            (await getBalance(account.address)) === balanceBefore + amount,
          // The transaction has already been submitted; cancelling the UI
          // must not cancel read-only reconciliation or permit rebroadcast.
          signal: undefined,
          timeoutMs: Math.min(
            timeoutMs,
            TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS,
          ),
        });
        if (verification.outcome === "failure") {
          return {
            ...result,
            finalized: false,
            failureReason: SAFE_FAUCET_ERROR_MESSAGE,
            attempts: 1,
          };
        }
        postStateConfirmed = verification.source === "post-state";
      } catch (error) {
        if (error instanceof SubmittedTransactionUncertainError) {
          return {
            signature: error.signature,
            finalized: false,
            failureReason: SAFE_FAUCET_UNCERTAIN_MESSAGE,
            attempts: 1,
          };
        }
        throw error;
      }
    }

    if (postStateConfirmed) {
      return {
        signature: result.signature,
        finalized: true,
        attempts: 1,
      };
    }

    const confirmedBalance = await waitForBalanceIncrease(
      account.address,
      balanceBefore,
      amount,
      undefined,
    );
    if (confirmedBalance !== null) {
      return {
        signature: result.signature,
        finalized: true,
        attempts: 1,
      };
    }
    if (result.signature || result.finalized) {
      return {
        ...result,
        finalized: false,
        failureReason: result.finalized
          ? SAFE_FAUCET_ERROR_MESSAGE
          : SAFE_FAUCET_UNCERTAIN_MESSAGE,
        attempts: 1,
      };
    }
  } catch (error) {
    if (signal?.aborted && !(error instanceof SubmittedTransactionUncertainError)) {
      throw error;
    }
  }

  return {
    signature: "",
    finalized: false,
    failureReason: SAFE_FAUCET_ERROR_MESSAGE,
    attempts: 1,
  };
}

async function attemptFaucetWithdraw(
  account: ThruAccount,
  amount: bigint,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Omit<FaucetWithdrawResult, "attempts">> {
  signal?.throwIfAborted();
  const transaction = await buildTransactionForSigning({
    feePayer: {
      publicKey: account.publicKey,
    },
    program: FAUCET_PROGRAM_ADDRESS,
    accounts: {
      readWrite: [FAUCET_ACCOUNT_ADDRESS],
    },
    header: {
      fee: 0n,
      ...FAUCET_TRANSACTION_RESOURCES,
      expiryAfter: 100,
    },
    instructionData: async ({ getAccountIndex }) =>
      buildFaucetWithdrawInstruction(
        getAccountIndex(FAUCET_ACCOUNT_ADDRESS),
        getAccountIndex(account.publicKey),
        amount,
      ),
  }, signal);
  await signTransactionForSubmission(
    transaction,
    account.privateKey,
    signal,
  );
  const rawTransaction = transaction.toWire();
  signal?.throwIfAborted();

  let signature = "";
  let finalConsensus = false;
  let executionSucceeded = false;
  let finalized = false;
  let failureReason: string | undefined;
  let definitiveTrackingFailure = false;
  let submissionStarted = false;

  signature = transaction.getSignature()?.toThruFmt() ?? "";
  try {
    submissionStarted = true;
    for await (const update of thru.transactions.sendAndTrack(rawTransaction, {
      timeoutMs,
      signal,
    })) {
      if (update.signature?.value) {
        const trackedSignature = Signature.from(
          update.signature.value,
        ).toThruFmt();
        if (signature && trackedSignature !== signature) {
          definitiveTrackingFailure = true;
          throw new Error(
            "The tracked faucet transaction signature does not match.",
          );
        }
        signature = trackedSignature;
      }

      if (update.executionResult) {
        const { vmError, userErrorCode } = update.executionResult;
        if (vmError !== 0 || userErrorCode !== 0n) {
          failureReason =
            "The faucet transaction was rejected during execution.";
        } else {
          executionSucceeded = true;
        }
      }

      if (update.consensusStatus === ConsensusStatus.FINALIZED) {
        finalConsensus = true;
      }
      finalized = executionSucceeded && finalConsensus;
      if (failureReason || finalized) break;
    }
  } catch (error) {
    if (!submissionStarted || definitiveTrackingFailure || !signature) {
      throw error;
    }
    // The signed request has already been submitted. The caller performs
    // read-only finalization and exact balance verification without retrying.
  }

  return { signature, finalized, failureReason };
}

async function waitForBalanceIncrease(
  address: string,
  balanceBefore: bigint,
  expectedIncrease: bigint,
  signal?: AbortSignal,
): Promise<bigint | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    signal?.throwIfAborted();
    const balance = await getBalance(address).catch(() => null);
    if (balance !== null && balance === balanceBefore + expectedIncrease) {
      return balance;
    }
    await abortableDelay(Math.min(500 * 2 ** attempt, 4_000), signal);
  }
  return null;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
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
