import {
  ConsensusStatus,
  Pubkey,
  Signature,
  type BuildTransactionOptions,
  type SendAndTrackTxnUpdate,
} from "@thru/sdk";
import { StateProofType } from "@thru/sdk/proto";
import {
  isAccountNotFoundError,
  parseTokenAccountData,
  type TokenAccountInfo,
} from "@thru/programs/token";
import { deriveDestinationTokenAccount } from "../../token/destination-account";
import { TOKEN_AMOUNT_MAX_RAW } from "../../token/validation";
import {
  buildTransactionForSigning,
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  signTransactionForSubmission,
  SubmittedTransactionUncertainError,
  TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS,
  verifySubmittedTransaction,
} from "../transactions";
import { thru, type ThruAccount } from "../../wallet/thru-wallet";
import type {
  NameLookupSnapshot,
  RegistrarConfigState,
} from "./account-types";
import {
  NAME_LABEL_MAX_UTF8_BYTES,
  NAME_SERVICE_PROGRAM_ADDRESS,
  REGISTRAR_PROGRAM_ADDRESS,
} from "./constants";
import { deriveRegistrarConfigAddress } from "./derivation";
import { lookupThruName } from "./lookup";
import { validateNameLabel, type ValidatedNameLabel } from "./validation";

export const PURCHASE_INSTRUCTION_DISCRIMINATOR = 1;
export const PURCHASE_INSTRUCTION_HEADER_BYTES = 91;
export const PURCHASE_TRANSACTION_RESOURCES = Object.freeze({
  fee: 0n,
  expiryAfter: 100,
  computeUnits: 500_000,
  stateUnits: 10_000,
  memoryUnits: 10_000,
});

export const PURCHASE_PROGRESS_STAGES = [
  "checking-availability",
  "refreshing-price",
  "validating-payment-account",
  "generating-state-proofs",
  "waiting-wallet-signature",
  "submitting-transaction",
  "confirming-transaction",
  "verifying-ownership",
] as const;

export type PurchaseProgressStage =
  (typeof PURCHASE_PROGRESS_STAGES)[number];

export type PurchaseErrorCode =
  | "INVALID_LABEL"
  | "INVALID_YEARS"
  | "NAME_UNAVAILABLE"
  | "RPC_UNAVAILABLE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "PAYER_TOKEN_ACCOUNT_NOT_FOUND"
  | "PAYER_TOKEN_ACCOUNT_INVALID"
  | "INSUFFICIENT_PAYMENT_BALANCE"
  | "PROOF_GENERATION_FAILED"
  | "TRANSACTION_BUILD_FAILED"
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_TIMEOUT"
  | "POST_STATE_MISMATCH"
  | "OPERATION_ABORTED";

export class PurchaseError extends Error {
  readonly code: PurchaseErrorCode;
  readonly signature?: string;

  constructor(
    code: PurchaseErrorCode,
    message: string,
    signature?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
    this.code = code;
    this.signature = signature;
  }
}

interface ParsedAddress {
  address: string;
  bytes: Uint8Array;
  byteKey: string;
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function parseAddress(
  value: string,
  label: string,
  code: PurchaseErrorCode = "TRANSACTION_BUILD_FAILED",
): ParsedAddress {
  if (typeof value !== "string" || value.length === 0) {
    throw new PurchaseError(code, `${label} is missing.`);
  }

  try {
    const pubkey = Pubkey.from(value);
    const bytes = pubkey.toBytes();
    if (bytes.length !== 32) {
      throw new Error("invalid public-key byte length");
    }
    return {
      address: pubkey.toThruFmt(),
      bytes,
      byteKey: bytesKey(bytes),
    };
  } catch {
    throw new PurchaseError(code, `${label} is not a valid Thru address.`);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== 32 || b.length !== 32) {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "A transaction account has an invalid public-key byte length.",
    );
  }
  for (let index = 0; index < 32; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function sortPubkeysLexicographically(addresses: string[]): string[] {
  return addresses
    .map((address, index) =>
      parseAddress(address, `Transaction account ${index + 1}`),
    )
    .sort((left, right) => compareBytes(left.bytes, right.bytes))
    .map(({ address }) => address);
}

export interface PurchaseAccountsInput {
  feePayer: string;
  registrarProgram: string;
  configAccount: string;
  leaseAccount: string;
  domainAccount: string;
  treasurerTokenAccount: string;
  payerTokenAccount: string;
  rootRegistrarAccount: string;
  nameServiceProgram: string;
  paymentMintAccount: string;
  tokenProgram: string;
}

export interface PurchaseAccountLayout {
  feePayer: string;
  registrarProgram: string;
  sortedReadWriteAccounts: string[];
  sortedReadOnlyAccounts: string[];
  wireAccounts: string[];
}

const READ_WRITE_ACCOUNT_FIELDS = [
  ["configAccount", "Registrar config account"],
  ["leaseAccount", "Lease account"],
  ["domainAccount", "Domain account"],
  ["treasurerTokenAccount", "Treasurer token account"],
  ["payerTokenAccount", "Payer token account"],
  ["rootRegistrarAccount", "Root registrar account"],
] as const;

const READ_ONLY_ACCOUNT_FIELDS = [
  ["nameServiceProgram", "Name Service program"],
  ["paymentMintAccount", "Payment mint account"],
  ["tokenProgram", "Token program"],
] as const;

export function buildPurchaseAccountLayout(
  input: PurchaseAccountsInput,
): PurchaseAccountLayout {
  const feePayer = parseAddress(input.feePayer, "Fee payer");
  const registrarProgram = parseAddress(
    input.registrarProgram,
    "Registrar program",
  );
  const readWrite = READ_WRITE_ACCOUNT_FIELDS.map(([field, label]) =>
    parseAddress(input[field], label),
  );
  const readOnly = READ_ONLY_ACCOUNT_FIELDS.map(([field, label]) =>
    parseAddress(input[field], label),
  );

  const allAccounts = [feePayer, registrarProgram, ...readWrite, ...readOnly];
  const seen = new Set<string>();
  for (const account of allAccounts) {
    if (seen.has(account.byteKey)) {
      throw new PurchaseError(
        "TRANSACTION_BUILD_FAILED",
        "Duplicate accounts are not allowed in a purchase transaction.",
      );
    }
    seen.add(account.byteKey);
  }

  readWrite.sort((left, right) => compareBytes(left.bytes, right.bytes));
  readOnly.sort((left, right) => compareBytes(left.bytes, right.bytes));

  const sortedReadWriteAccounts = readWrite.map(({ address }) => address);
  const sortedReadOnlyAccounts = readOnly.map(({ address }) => address);
  const wireAccounts = [
    feePayer.address,
    registrarProgram.address,
    ...sortedReadWriteAccounts,
    ...sortedReadOnlyAccounts,
  ];

  return {
    feePayer: feePayer.address,
    registrarProgram: registrarProgram.address,
    sortedReadWriteAccounts,
    sortedReadOnlyAccounts,
    wireAccounts,
  };
}

export interface PurchaseAccountIndexes {
  configAccountIdx: number;
  leaseAccountIdx: number;
  domainAccountIdx: number;
  nameServiceProgramIdx: number;
  rootRegistrarAccountIdx: number;
  treasurerTokenAccountIdx: number;
  payerTokenAccountIdx: number;
  paymentMintAccountIdx: number;
  tokenProgramIdx: number;
}

export function resolvePurchaseAccountIndexes(
  input: PurchaseAccountsInput,
  layout: PurchaseAccountLayout,
): PurchaseAccountIndexes {
  const findIndex = (address: string, label: string): number => {
    const expected = parseAddress(address, label);
    const index = layout.wireAccounts.findIndex((candidate) => {
      try {
        return parseAddress(candidate, label).byteKey === expected.byteKey;
      } catch {
        return false;
      }
    });

    if (index === -1) {
      throw new PurchaseError(
        "TRANSACTION_BUILD_FAILED",
        `${label} is missing from the transaction account layout.`,
      );
    }
    if (index > 0xffff) {
      throw new PurchaseError(
        "TRANSACTION_BUILD_FAILED",
        `${label} index exceeds the u16 wire limit.`,
      );
    }
    return index;
  };

  return {
    configAccountIdx: findIndex(input.configAccount, "Registrar config account"),
    leaseAccountIdx: findIndex(input.leaseAccount, "Lease account"),
    domainAccountIdx: findIndex(input.domainAccount, "Domain account"),
    nameServiceProgramIdx: findIndex(
      input.nameServiceProgram,
      "Name Service program",
    ),
    rootRegistrarAccountIdx: findIndex(
      input.rootRegistrarAccount,
      "Root registrar account",
    ),
    treasurerTokenAccountIdx: findIndex(
      input.treasurerTokenAccount,
      "Treasurer token account",
    ),
    payerTokenAccountIdx: findIndex(
      input.payerTokenAccount,
      "Payer token account",
    ),
    paymentMintAccountIdx: findIndex(
      input.paymentMintAccount,
      "Payment mint account",
    ),
    tokenProgramIdx: findIndex(input.tokenProgram, "Token program"),
  };
}

export function validatePurchaseLabel(value: string): ValidatedNameLabel {
  try {
    return validateNameLabel(value);
  } catch {
    if (typeof value === "string" && value.includes(".")) {
      throw new PurchaseError(
        "INVALID_LABEL",
        "Enter only the label, without dots or the .thru suffix.",
      );
    }
    if (
      typeof value === "string" &&
      new TextEncoder().encode(value).length > NAME_LABEL_MAX_UTF8_BYTES
    ) {
      throw new PurchaseError(
        "INVALID_LABEL",
        `The label must be ${NAME_LABEL_MAX_UTF8_BYTES} UTF-8 bytes or fewer.`,
      );
    }
    throw new PurchaseError("INVALID_LABEL", "A .thru label is required.");
  }
}

export function validatePurchaseYears(years: number): number {
  if (!Number.isInteger(years) || years < 1 || years > 0xff) {
    throw new PurchaseError(
      "INVALID_YEARS",
      "Years must be an integer between 1 and 255.",
    );
  }
  return years;
}

export function calculatePurchasePrice(
  pricePerYear: bigint,
  years: number,
): bigint {
  const validYears = validatePurchaseYears(years);
  if (
    typeof pricePerYear !== "bigint" ||
    pricePerYear < 0n ||
    pricePerYear > TOKEN_AMOUNT_MAX_RAW
  ) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The registrar price is invalid.",
    );
  }

  const price = pricePerYear * BigInt(validYears);
  if (price > TOKEN_AMOUNT_MAX_RAW) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The total registration price exceeds the token amount limit.",
    );
  }
  return price;
}

function requireU16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      `${label} is not a valid u16 account index.`,
    );
  }
}

export interface BuildPurchaseDomainInstructionHeaderInput {
  indexes: PurchaseAccountIndexes;
  label: string;
  years: number;
}

export function buildPurchaseDomainInstructionHeader(
  input: BuildPurchaseDomainInstructionHeaderInput,
): Uint8Array {
  const validated = validatePurchaseLabel(input.label);
  const years = validatePurchaseYears(input.years);
  const indexEntries = [
    ["configAccountIdx", input.indexes.configAccountIdx],
    ["leaseAccountIdx", input.indexes.leaseAccountIdx],
    ["domainAccountIdx", input.indexes.domainAccountIdx],
    ["nameServiceProgramIdx", input.indexes.nameServiceProgramIdx],
    ["rootRegistrarAccountIdx", input.indexes.rootRegistrarAccountIdx],
    ["treasurerTokenAccountIdx", input.indexes.treasurerTokenAccountIdx],
    ["payerTokenAccountIdx", input.indexes.payerTokenAccountIdx],
    ["paymentMintAccountIdx", input.indexes.paymentMintAccountIdx],
    ["tokenProgramIdx", input.indexes.tokenProgramIdx],
  ] as const;
  for (const [label, value] of indexEntries) requireU16(value, label);

  const header = new Uint8Array(PURCHASE_INSTRUCTION_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, PURCHASE_INSTRUCTION_DISCRIMINATOR, true);
  view.setUint16(4, input.indexes.configAccountIdx, true);
  view.setUint16(6, input.indexes.leaseAccountIdx, true);
  view.setUint16(8, input.indexes.domainAccountIdx, true);
  view.setUint16(10, input.indexes.nameServiceProgramIdx, true);
  view.setUint16(12, input.indexes.rootRegistrarAccountIdx, true);
  view.setUint16(14, input.indexes.treasurerTokenAccountIdx, true);
  view.setUint16(16, input.indexes.payerTokenAccountIdx, true);
  view.setUint16(18, input.indexes.paymentMintAccountIdx, true);
  view.setUint16(20, input.indexes.tokenProgramIdx, true);
  header.set(validated.bytes, 22);
  view.setUint32(86, validated.bytes.length, true);
  view.setUint8(90, years);
  return header;
}

export function concatenatePurchaseProofs(
  header: Uint8Array,
  leaseProof: Uint8Array,
  domainProof: Uint8Array,
): Uint8Array {
  if (header.length !== PURCHASE_INSTRUCTION_HEADER_BYTES) {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "The purchase instruction header has an invalid length.",
    );
  }
  if (!(leaseProof instanceof Uint8Array) || leaseProof.length === 0) {
    throw new PurchaseError(
      "PROOF_GENERATION_FAILED",
      "The lease creation proof is missing.",
    );
  }
  if (!(domainProof instanceof Uint8Array) || domainProof.length === 0) {
    throw new PurchaseError(
      "PROOF_GENERATION_FAILED",
      "The domain creation proof is missing.",
    );
  }

  const instruction = new Uint8Array(
    header.length + leaseProof.length + domainProof.length,
  );
  instruction.set(header, 0);
  instruction.set(leaseProof, header.length);
  instruction.set(domainProof, header.length + leaseProof.length);
  return instruction;
}

export interface BuildPurchaseDomainInstructionInput
  extends BuildPurchaseDomainInstructionHeaderInput {
  leaseProof: Uint8Array;
  domainProof: Uint8Array;
}

export function buildPurchaseDomainInstructionData(
  input: BuildPurchaseDomainInstructionInput,
): Uint8Array {
  return concatenatePurchaseProofs(
    buildPurchaseDomainInstructionHeader(input),
    input.leaseProof,
    input.domainProof,
  );
}

function addressesEqual(left: string, right: string): boolean {
  try {
    return (
      parseAddress(left, "Address").byteKey ===
      parseAddress(right, "Address").byteKey
    );
  } catch {
    return false;
  }
}

export interface ValidatePayerTokenAccountInput {
  tokenAccount: TokenAccountInfo | null | undefined;
  accountMetaOwner?: string;
  expectedTokenProgramId: string;
  expectedMint: string;
  expectedOwner: string;
  requiredAmount: bigint;
}

export function validatePayerTokenAccount(
  input: ValidatePayerTokenAccountInput,
): void {
  if (!input.tokenAccount) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_NOT_FOUND",
      "The wallet payment token account does not exist.",
    );
  }
  if (
    !input.accountMetaOwner ||
    !addressesEqual(input.accountMetaOwner, input.expectedTokenProgramId)
  ) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account is not owned by the configured Token Program.",
    );
  }
  if (!addressesEqual(input.tokenAccount.mint, input.expectedMint)) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account uses the wrong mint.",
    );
  }
  if (!addressesEqual(input.tokenAccount.owner, input.expectedOwner)) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account is not owned by the current wallet.",
    );
  }
  if (input.tokenAccount.isFrozen) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account is frozen.",
    );
  }
  if (
    typeof input.tokenAccount.amount !== "bigint" ||
    input.tokenAccount.amount < 0n
  ) {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account balance is invalid.",
    );
  }
  if (input.tokenAccount.amount < input.requiredAmount) {
    throw new PurchaseError(
      "INSUFFICIENT_PAYMENT_BALANCE",
      "The payment token account does not have enough balance.",
    );
  }
}

export interface ValidateTreasurerTokenAccountInput {
  tokenAccount: TokenAccountInfo | null | undefined;
  accountMetaOwner?: string;
  expectedTokenProgramId: string;
  expectedMint: string;
}

export function validateTreasurerTokenAccount(
  input: ValidateTreasurerTokenAccountInput,
): void {
  if (!input.tokenAccount) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The configured treasurer token account does not exist.",
    );
  }
  if (
    !input.accountMetaOwner ||
    !addressesEqual(input.accountMetaOwner, input.expectedTokenProgramId) ||
    !addressesEqual(input.tokenAccount.mint, input.expectedMint) ||
    input.tokenAccount.isFrozen ||
    typeof input.tokenAccount.amount !== "bigint" ||
    input.tokenAccount.amount < 0n
  ) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The configured treasurer token account is invalid.",
    );
  }
}

export interface PaymentTokenAccountRead {
  info: TokenAccountInfo | null;
  accountMetaOwner?: string;
}

export type PaymentTokenAccountReader = (
  address: string,
  signal?: AbortSignal,
) => Promise<PaymentTokenAccountRead>;

export type PurchaseNameLookup = (
  label: string,
  options?: { signal?: AbortSignal },
) => Promise<NameLookupSnapshot>;

export type CreationProofGenerator = (
  address: string,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

export interface PurchaseTransaction {
  sign(privateKey: Uint8Array): Promise<unknown>;
  toWire(): Uint8Array;
  getSignature?(): { toThruFmt(): string } | undefined;
}

export type PurchaseTransactionBuilder = (
  options: BuildTransactionOptions,
  signal?: AbortSignal,
) => Promise<PurchaseTransaction>;

export type PurchaseTransactionSender = (
  transaction: Uint8Array,
  options: { timeoutMs?: number; signal?: AbortSignal },
) => AsyncIterable<SendAndTrackTxnUpdate>;

export interface PurchaseEngineDependencies {
  lookupName?: PurchaseNameLookup;
  readTokenAccount?: PaymentTokenAccountReader;
  generateCreationProof?: CreationProofGenerator;
  buildTransaction?: PurchaseTransactionBuilder;
  sendAndTrack?: PurchaseTransactionSender;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function safeAbortError(): PurchaseError {
  return new PurchaseError("OPERATION_ABORTED", "The purchase was cancelled.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw safeAbortError();
}

async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(safeAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function defaultReadTokenAccount(
  address: string,
  signal?: AbortSignal,
): Promise<PaymentTokenAccountRead> {
  let account;
  try {
    account = await abortable(
      thru.accounts.get(address, {
        minConsensus: ConsensusStatus.FINALIZED,
      }),
      signal,
    );
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    if (isAccountNotFoundError(error)) return { info: null };
    throw new PurchaseError(
      "RPC_UNAVAILABLE",
      "The payment token account could not be read.",
    );
  }

  const rawOwner = account.meta?.owner;
  const accountMetaOwner =
    typeof rawOwner === "string" ? rawOwner : rawOwner?.toThruFmt();
  try {
    return {
      info: parseTokenAccountData(account),
      accountMetaOwner,
    };
  } catch {
    throw new PurchaseError(
      "PAYER_TOKEN_ACCOUNT_INVALID",
      "The payment token account data is invalid.",
    );
  }
}

async function defaultGenerateCreationProof(
  address: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    const stateProof = await abortable(
      thru.proofs.generate({
        address,
        proofType: StateProofType.CREATING,
      }),
      signal,
    );
    if (
      !(stateProof.proof instanceof Uint8Array) ||
      stateProof.proof.length === 0
    ) {
      throw new Error("empty proof");
    }
    return stateProof.proof.slice();
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    throw new PurchaseError(
      "PROOF_GENERATION_FAILED",
      "A fresh account-creation proof could not be generated.",
    );
  }
}

const defaultBuildTransaction: PurchaseTransactionBuilder = (options, signal) =>
  buildTransactionForSigning(options, signal);

const defaultSendAndTrack: PurchaseTransactionSender = (transaction, options) =>
  thru.transactions.sendAndTrack(transaction, options);

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(safeAbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(safeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateRegistrarSnapshot(
  snapshot: NameLookupSnapshot,
): RegistrarConfigState {
  const config = snapshot?.config as RegistrarConfigState | undefined;
  if (!config) {
    throw new PurchaseError(
      "CONFIG_NOT_FOUND",
      "The registrar config account was not found.",
    );
  }

  const expectedConfigAddress = deriveRegistrarConfigAddress();
  if (!addressesEqual(snapshot.configAddress, expectedConfigAddress)) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The registrar config address is invalid.",
    );
  }
  if (
    !addressesEqual(
      config.nameServiceProgramId,
      NAME_SERVICE_PROGRAM_ADDRESS,
    )
  ) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The registrar config references an unexpected Name Service program.",
    );
  }

  parseAddress(
    config.rootRegistrar,
    "Configured root registrar",
    "CONFIG_INVALID",
  );
  parseAddress(
    config.treasurerTokenAccount,
    "Configured treasurer token account",
    "CONFIG_INVALID",
  );
  parseAddress(config.paymentMint, "Configured payment mint", "CONFIG_INVALID");
  parseAddress(config.tokenProgramId, "Configured Token Program", "CONFIG_INVALID");

  if (
    typeof config.pricePerYear !== "bigint" ||
    config.pricePerYear < 0n ||
    config.pricePerYear > TOKEN_AMOUNT_MAX_RAW
  ) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The registrar config contains an invalid price.",
    );
  }
  return config;
}

function assertNameAvailable(snapshot: NameLookupSnapshot): void {
  if (
    snapshot.domain.status !== "not-found" ||
    snapshot.lease.status !== "not-found"
  ) {
    throw new PurchaseError(
      "NAME_UNAVAILABLE",
      "The requested .thru name is already registered or otherwise unavailable.",
    );
  }
}

async function fetchPurchaseSnapshot(
  label: string,
  lookupName: PurchaseNameLookup,
  signal?: AbortSignal,
): Promise<NameLookupSnapshot> {
  throwIfAborted(signal);
  let snapshot: NameLookupSnapshot;
  try {
    snapshot = await abortable(lookupName(label, { signal }), signal);
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    if (isAccountNotFoundError(error)) {
      throw new PurchaseError(
        "CONFIG_NOT_FOUND",
        "The registrar config account was not found.",
      );
    }
    throw new PurchaseError(
      "RPC_UNAVAILABLE",
      "The latest name-service state could not be read.",
    );
  }

  validateRegistrarSnapshot(snapshot);
  if (snapshot.label !== label) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The name lookup returned a mismatched label.",
    );
  }
  assertNameAvailable(snapshot);
  return snapshot;
}

export function derivePaymentTokenAccountAddress(input: {
  walletAddress: string;
  paymentMint: string;
  tokenProgramId: string;
}): string {
  try {
    return deriveDestinationTokenAccount(thru, {
      mintAddress: input.paymentMint,
      destinationOwnerAddress: input.walletAddress,
      tokenProgramAddress: input.tokenProgramId,
    }).tokenAccountAddress;
  } catch {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The wallet payment token account address could not be derived.",
    );
  }
}

async function readAndValidatePaymentAccount(input: {
  address: string;
  walletAddress: string;
  config: RegistrarConfigState;
  requiredAmount: bigint;
  readTokenAccount: PaymentTokenAccountReader;
  signal?: AbortSignal;
}): Promise<void> {
  let account: PaymentTokenAccountRead;
  try {
    account = await abortable(
      input.readTokenAccount(input.address, input.signal),
      input.signal,
    );
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    if (isAccountNotFoundError(error)) {
      throw new PurchaseError(
        "PAYER_TOKEN_ACCOUNT_NOT_FOUND",
        "The wallet payment token account does not exist.",
      );
    }
    throw new PurchaseError(
      "RPC_UNAVAILABLE",
      "The payment token account could not be read.",
    );
  }

  validatePayerTokenAccount({
    tokenAccount: account.info,
    accountMetaOwner: account.accountMetaOwner,
    expectedTokenProgramId: input.config.tokenProgramId,
    expectedMint: input.config.paymentMint,
    expectedOwner: input.walletAddress,
    requiredAmount: input.requiredAmount,
  });
}

async function readAndValidateTreasurerAccount(input: {
  config: RegistrarConfigState;
  readTokenAccount: PaymentTokenAccountReader;
  signal?: AbortSignal;
}): Promise<void> {
  let account: PaymentTokenAccountRead;
  try {
    account = await abortable(
      input.readTokenAccount(
        input.config.treasurerTokenAccount,
        input.signal,
      ),
      input.signal,
    );
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    throw new PurchaseError(
      "RPC_UNAVAILABLE",
      "The treasurer token account could not be read.",
    );
  }

  validateTreasurerTokenAccount({
    tokenAccount: account.info,
    accountMetaOwner: account.accountMetaOwner,
    expectedTokenProgramId: input.config.tokenProgramId,
    expectedMint: input.config.paymentMint,
  });
}

export interface PreparePurchaseDomainInput {
  label: string;
  years: number;
  walletAddress: string;
  payerTokenAccountAddress?: string;
  lookupName?: PurchaseNameLookup;
  readTokenAccount?: PaymentTokenAccountReader;
  signal?: AbortSignal;
}

export interface PreparedPurchaseDomain {
  label: string;
  years: number;
  price: bigint;
  walletAddress: string;
  configAddress: string;
  leaseAddress: string;
  domainAddress: string;
  treasurerTokenAccount: string;
  payerTokenAccount: string;
  rootRegistrarAccount: string;
  nameServiceProgram: string;
  paymentMintAccount: string;
  tokenProgram: string;
  config: RegistrarConfigState;
}

export type PurchasePaymentReadiness =
  | { status: "ready" }
  | {
      status: "missing" | "invalid" | "insufficient";
      code:
        | "PAYER_TOKEN_ACCOUNT_NOT_FOUND"
        | "PAYER_TOKEN_ACCOUNT_INVALID"
        | "INSUFFICIENT_PAYMENT_BALANCE";
      message: string;
    };

export interface PurchaseDomainQuote extends PreparedPurchaseDomain {
  payment: PurchasePaymentReadiness;
}

async function resolvePurchaseDomain(
  input: PreparePurchaseDomainInput,
): Promise<PreparedPurchaseDomain> {
  const validated = validatePurchaseLabel(input.label);
  const years = validatePurchaseYears(input.years);
  const walletAddress = parseAddress(
    input.walletAddress,
    "Current wallet",
    "TRANSACTION_BUILD_FAILED",
  ).address;
  const lookupName = input.lookupName ?? lookupThruName;
  const snapshot = await fetchPurchaseSnapshot(
    validated.label,
    lookupName,
    input.signal,
  );
  const config = validateRegistrarSnapshot(snapshot);
  const price = calculatePurchasePrice(config.pricePerYear, years);
  const payerTokenAccount = input.payerTokenAccountAddress
    ? parseAddress(
        input.payerTokenAccountAddress,
        "Payment token account",
        "PAYER_TOKEN_ACCOUNT_INVALID",
      ).address
    : derivePaymentTokenAccountAddress({
        walletAddress,
        paymentMint: config.paymentMint,
        tokenProgramId: config.tokenProgramId,
      });

  return {
    label: validated.label,
    years,
    price,
    walletAddress,
    configAddress: snapshot.configAddress,
    leaseAddress: snapshot.leaseAddress,
    domainAddress: snapshot.domainAddress,
    treasurerTokenAccount: config.treasurerTokenAccount,
    payerTokenAccount,
    rootRegistrarAccount: config.rootRegistrar,
    nameServiceProgram: config.nameServiceProgramId,
    paymentMintAccount: config.paymentMint,
    tokenProgram: config.tokenProgramId,
    config,
  };
}

async function validatePreparedPurchaseAccounts(input: {
  prepared: PreparedPurchaseDomain;
  readTokenAccount: PaymentTokenAccountReader;
  signal?: AbortSignal;
}): Promise<void> {
  await readAndValidatePaymentAccount({
    address: input.prepared.payerTokenAccount,
    walletAddress: input.prepared.walletAddress,
    config: input.prepared.config,
    requiredAmount: input.prepared.price,
    readTokenAccount: input.readTokenAccount,
    signal: input.signal,
  });
  await readAndValidateTreasurerAccount({
    config: input.prepared.config,
    readTokenAccount: input.readTokenAccount,
    signal: input.signal,
  });
}

function paymentReadinessFromError(
  error: PurchaseError,
): Exclude<PurchasePaymentReadiness, { status: "ready" }> | null {
  if (error.code === "PAYER_TOKEN_ACCOUNT_NOT_FOUND") {
    return {
      status: "missing",
      code: error.code,
      message: error.message,
    };
  }
  if (error.code === "PAYER_TOKEN_ACCOUNT_INVALID") {
    return {
      status: "invalid",
      code: error.code,
      message: error.message,
    };
  }
  if (error.code === "INSUFFICIENT_PAYMENT_BALANCE") {
    return {
      status: "insufficient",
      code: error.code,
      message: error.message,
    };
  }
  return null;
}

export async function quotePurchaseDomain(
  input: PreparePurchaseDomainInput,
): Promise<PurchaseDomainQuote> {
  const prepared = await resolvePurchaseDomain(input);
  const readTokenAccount = input.readTokenAccount ?? defaultReadTokenAccount;
  let payment: PurchasePaymentReadiness = { status: "ready" };

  try {
    await readAndValidatePaymentAccount({
      address: prepared.payerTokenAccount,
      walletAddress: prepared.walletAddress,
      config: prepared.config,
      requiredAmount: prepared.price,
      readTokenAccount,
      signal: input.signal,
    });
  } catch (error) {
    if (!(error instanceof PurchaseError)) throw error;
    const readiness = paymentReadinessFromError(error);
    if (!readiness) throw error;
    payment = readiness;
  }

  await readAndValidateTreasurerAccount({
    config: prepared.config,
    readTokenAccount,
    signal: input.signal,
  });

  return { ...prepared, payment };
}

export async function preparePurchaseDomain(
  input: PreparePurchaseDomainInput,
): Promise<PreparedPurchaseDomain> {
  const { payment, ...prepared } = await quotePurchaseDomain(input);
  if (payment.status !== "ready") {
    throw new PurchaseError(payment.code, payment.message);
  }
  return prepared;
}

function purchaseAccounts(
  prepared: PreparedPurchaseDomain,
): PurchaseAccountsInput {
  return {
    feePayer: prepared.walletAddress,
    registrarProgram: REGISTRAR_PROGRAM_ADDRESS,
    configAccount: prepared.configAddress,
    leaseAccount: prepared.leaseAddress,
    domainAccount: prepared.domainAddress,
    treasurerTokenAccount: prepared.treasurerTokenAccount,
    payerTokenAccount: prepared.payerTokenAccount,
    rootRegistrarAccount: prepared.rootRegistrarAccount,
    nameServiceProgram: prepared.nameServiceProgram,
    paymentMintAccount: prepared.paymentMintAccount,
    tokenProgram: prepared.tokenProgram,
  };
}

function assertPreparedStateStable(
  before: PreparedPurchaseDomain,
  after: PreparedPurchaseDomain,
): void {
  const addressPairs = [
    [before.walletAddress, after.walletAddress],
    [before.configAddress, after.configAddress],
    [before.leaseAddress, after.leaseAddress],
    [before.domainAddress, after.domainAddress],
    [before.treasurerTokenAccount, after.treasurerTokenAccount],
    [before.payerTokenAccount, after.payerTokenAccount],
    [before.rootRegistrarAccount, after.rootRegistrarAccount],
    [before.nameServiceProgram, after.nameServiceProgram],
    [before.paymentMintAccount, after.paymentMintAccount],
    [before.tokenProgram, after.tokenProgram],
  ];
  if (
    before.label !== after.label ||
    before.years !== after.years ||
    before.price !== after.price ||
    before.config.rootDomainName !== after.config.rootDomainName ||
    addressPairs.some(([left, right]) => !addressesEqual(left, right))
  ) {
    throw new PurchaseError(
      "CONFIG_INVALID",
      "The registrar configuration changed during purchase preparation.",
    );
  }
}

export interface BuildPurchaseTransactionInput {
  prepared: PreparedPurchaseDomain;
  walletPublicKey: Uint8Array;
  leaseProof: Uint8Array;
  domainProof: Uint8Array;
  buildTransaction?: PurchaseTransactionBuilder;
  signal?: AbortSignal;
}

export async function buildPurchaseTransaction(
  input: BuildPurchaseTransactionInput,
): Promise<PurchaseTransaction> {
  const accounts = purchaseAccounts(input.prepared);
  const layout = buildPurchaseAccountLayout(accounts);
  const buildTransaction =
    input.buildTransaction ?? defaultBuildTransaction;

  try {
    return await buildTransaction({
      feePayer: { publicKey: input.walletPublicKey },
      program: REGISTRAR_PROGRAM_ADDRESS,
      accounts: {
        readWrite: layout.sortedReadWriteAccounts,
        readOnly: layout.sortedReadOnlyAccounts,
      },
      header: PURCHASE_TRANSACTION_RESOURCES,
      instructionData: async ({ accounts: finalAccounts, getAccountIndex }) => {
        const finalLayout: PurchaseAccountLayout = {
          ...layout,
          wireAccounts: finalAccounts.map((account) => account.toThruFmt()),
        };
        const indexes = resolvePurchaseAccountIndexes(accounts, finalLayout);

        const sdkIndexes = [
          [indexes.configAccountIdx, accounts.configAccount],
          [indexes.leaseAccountIdx, accounts.leaseAccount],
          [indexes.domainAccountIdx, accounts.domainAccount],
          [indexes.nameServiceProgramIdx, accounts.nameServiceProgram],
          [indexes.rootRegistrarAccountIdx, accounts.rootRegistrarAccount],
          [indexes.treasurerTokenAccountIdx, accounts.treasurerTokenAccount],
          [indexes.payerTokenAccountIdx, accounts.payerTokenAccount],
          [indexes.paymentMintAccountIdx, accounts.paymentMintAccount],
          [indexes.tokenProgramIdx, accounts.tokenProgram],
        ] as const;
        for (const [resolvedIndex, address] of sdkIndexes) {
          const sdkIndex = getAccountIndex(address);
          requireU16(sdkIndex, "SDK account index");
          if (sdkIndex !== resolvedIndex) {
            throw new PurchaseError(
              "TRANSACTION_BUILD_FAILED",
              "The SDK account order does not match the purchase instruction indexes.",
            );
          }
        }

        return buildPurchaseDomainInstructionData({
          indexes,
          label: input.prepared.label,
          years: input.prepared.years,
          leaseProof: input.leaseProof,
          domainProof: input.domainProof,
        });
      },
    }, input.signal);
  } catch (error) {
    if (error instanceof PurchaseError) throw error;
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "The purchase transaction could not be built.",
    );
  }
}

function validateWallet(account: ThruAccount): string {
  const wallet = parseAddress(
    account.address,
    "Current wallet",
    "TRANSACTION_BUILD_FAILED",
  );
  if (
    !(account.publicKey instanceof Uint8Array) ||
    account.publicKey.length !== 32 ||
    bytesKey(account.publicKey) !== wallet.byteKey
  ) {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "The current wallet public key does not match its address.",
    );
  }
  if (
    !(account.privateKey instanceof Uint8Array) ||
    account.privateKey.length !== 32
  ) {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "The current wallet signing key is invalid.",
    );
  }
  return wallet.address;
}

async function generateFreshProofs(input: {
  prepared: PreparedPurchaseDomain;
  generateCreationProof: CreationProofGenerator;
  signal?: AbortSignal;
}): Promise<{ leaseProof: Uint8Array; domainProof: Uint8Array }> {
  try {
    const leaseProof = await abortable(
      input.generateCreationProof(input.prepared.leaseAddress, input.signal),
      input.signal,
    );
    const domainProof = await abortable(
      input.generateCreationProof(input.prepared.domainAddress, input.signal),
      input.signal,
    );
    if (
      !(leaseProof instanceof Uint8Array) ||
      leaseProof.length === 0 ||
      !(domainProof instanceof Uint8Array) ||
      domainProof.length === 0
    ) {
      throw new Error("invalid proof");
    }
    return {
      leaseProof: leaseProof.slice(),
      domainProof: domainProof.slice(),
    };
  } catch (error) {
    if (
      error instanceof PurchaseError &&
      error.code === "OPERATION_ABORTED"
    ) {
      throw error;
    }
    throw new PurchaseError(
      "PROOF_GENERATION_FAILED",
      "Fresh lease and domain creation proofs could not be generated.",
    );
  }
}

function isFinalConsensus(status: number): boolean {
  return (
    status === ConsensusStatus.FINALIZED ||
    status === ConsensusStatus.CLUSTER_EXECUTED
  );
}

async function submitAndTrackPurchase(input: {
  transaction: PurchaseTransaction;
  sendAndTrack: PurchaseTransactionSender;
  timeoutMs: number;
  signal?: AbortSignal;
  onSubmitting?: () => void;
  onConfirming?: () => void;
}): Promise<{
  signature: string;
  trackingConfirmed: boolean;
}> {
  let wire: Uint8Array;
  try {
    wire = input.transaction.toWire();
  } catch {
    throw new PurchaseError(
      "TRANSACTION_BUILD_FAILED",
      "The signed purchase transaction could not be serialized.",
    );
  }

  input.onSubmitting?.();
  let signature = input.transaction.getSignature?.()?.toThruFmt() ?? "";
  let confirmationReported = false;
  let finalized = false;
  let executionSucceeded = false;
  const updates = input
    .sendAndTrack(wire, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    [Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await abortable(updates.next(), input.signal);
      if (next.done) break;
      const update = next.value;
      throwIfAborted(input.signal);
      if (update.signature?.value) {
        try {
          const trackedSignature = Signature.from(
            update.signature.value,
          ).toThruFmt();
          if (signature && trackedSignature !== signature) {
            throw new PurchaseError(
              "TRANSACTION_REJECTED",
              "The tracked purchase signature does not match.",
            );
          }
          signature = trackedSignature;
          if (!confirmationReported) {
            confirmationReported = true;
            input.onConfirming?.();
          }
        } catch (error) {
          if (error instanceof PurchaseError) throw error;
          throw new PurchaseError(
            "TRANSACTION_REJECTED",
            "The network returned an invalid transaction signature.",
          );
        }
      }
      if (update.executionResult) {
        if (
          update.executionResult.vmError !== 0 ||
          update.executionResult.userErrorCode !== 0n
        ) {
          throw new PurchaseError(
            "TRANSACTION_REJECTED",
            "The purchase transaction was rejected during execution.",
          );
        }
        executionSucceeded = true;
      }
      if (isFinalConsensus(update.consensusStatus)) finalized = true;
      if (signature && finalized && executionSucceeded) {
        return { signature, trackingConfirmed: true };
      }
    }
  } catch (error) {
    if (
      error instanceof PurchaseError &&
      (error.code === "TRANSACTION_REJECTED" ||
        error.code === "OPERATION_ABORTED")
    ) {
      throw error;
    }
    if (!signature) {
      throw new PurchaseError(
        "TRANSACTION_TIMEOUT",
        "Transaction submission or tracking did not complete.",
      );
    }
  } finally {
    await updates.return?.().catch(() => undefined);
  }

  if (!signature) {
    throw new PurchaseError(
      "TRANSACTION_REJECTED",
      "The transaction ended without a signature.",
    );
  }
  if (!finalized || !executionSucceeded) {
    if (!confirmationReported) {
      confirmationReported = true;
      input.onConfirming?.();
    }
    return { signature, trackingConfirmed: false };
  }
  return { signature, trackingConfirmed: true };
}

export interface VerifyPurchasedDomainInput {
  label: string;
  expectedOwner: string;
  expected?: PreparedPurchaseDomain;
  maxAttempts?: number;
  intervalMs?: number;
  lookupName?: PurchaseNameLookup;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function assertPostStateRelationships(
  snapshot: NameLookupSnapshot,
  input: VerifyPurchasedDomainInput,
): void {
  if (snapshot.domain.status !== "found" || snapshot.lease.status !== "found") {
    return;
  }
  if (
    !addressesEqual(snapshot.domain.state.owner, input.expectedOwner) ||
    !addressesEqual(snapshot.lease.state.owner, input.expectedOwner)
  ) {
    throw new PurchaseError(
      "POST_STATE_MISMATCH",
      "The finalized domain is not owned by the current wallet.",
    );
  }
  if (
    snapshot.domain.state.name !== input.label ||
    snapshot.lease.state.domainName !== input.label ||
    !addressesEqual(
      snapshot.domain.state.parent,
      snapshot.config.rootRegistrar,
    ) ||
    !addressesEqual(
      snapshot.lease.state.domainAccount,
      snapshot.domainAddress,
    )
  ) {
    throw new PurchaseError(
      "POST_STATE_MISMATCH",
      "The finalized domain, root registrar, and lease relationships do not match.",
    );
  }

  if (input.expected) {
    const expected = input.expected;
    const matchesExpected =
      addressesEqual(snapshot.configAddress, expected.configAddress) &&
      addressesEqual(snapshot.domainAddress, expected.domainAddress) &&
      addressesEqual(snapshot.leaseAddress, expected.leaseAddress) &&
      addressesEqual(
        snapshot.config.rootRegistrar,
        expected.rootRegistrarAccount,
      ) &&
      addressesEqual(
        snapshot.config.nameServiceProgramId,
        expected.nameServiceProgram,
      ) &&
      addressesEqual(
        snapshot.config.treasurerTokenAccount,
        expected.treasurerTokenAccount,
      ) &&
      addressesEqual(
        snapshot.config.paymentMint,
        expected.paymentMintAccount,
      ) &&
      addressesEqual(snapshot.config.tokenProgramId, expected.tokenProgram);
    if (!matchesExpected) {
      throw new PurchaseError(
        "POST_STATE_MISMATCH",
        "The finalized registrar configuration does not match the signed purchase.",
      );
    }
  }
}

async function observePurchasedDomain(
  input: VerifyPurchasedDomainInput,
): Promise<NameLookupSnapshot | null> {
  const lookupName = input.lookupName ?? lookupThruName;
  const snapshot = await abortable(
    lookupName(input.label, { signal: input.signal }),
    input.signal,
  );

  try {
    validateRegistrarSnapshot(snapshot);
  } catch (error) {
    if (error instanceof PurchaseError) {
      throw new PurchaseError(
        "POST_STATE_MISMATCH",
        "The finalized registrar configuration is invalid.",
      );
    }
    throw error;
  }

  if (
    snapshot.domain.status === "invalid" ||
    snapshot.lease.status === "invalid"
  ) {
    throw new PurchaseError(
      "POST_STATE_MISMATCH",
      "The finalized domain or lease account is invalid.",
    );
  }

  if (
    snapshot.domain.status !== "found" ||
    snapshot.lease.status !== "found"
  ) {
    return null;
  }

  assertPostStateRelationships(snapshot, input);
  return snapshot;
}

export async function verifyPurchasedDomain(
  input: VerifyPurchasedDomainInput,
): Promise<NameLookupSnapshot> {
  const sleep = input.sleep ?? defaultSleep;
  const maxAttempts = input.maxAttempts ?? 15;
  const intervalMs = input.intervalMs ?? 1_000;
  validatePurchaseLabel(input.label);
  parseAddress(
    input.expectedOwner,
    "Expected owner",
    "POST_STATE_MISMATCH",
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    let snapshot: NameLookupSnapshot | null;
    try {
      snapshot = await observePurchasedDomain(input);
    } catch (error) {
      if (
        error instanceof PurchaseError &&
        error.code === "OPERATION_ABORTED"
      ) {
        throw error;
      }
      if (
        error instanceof PurchaseError &&
        error.code === "POST_STATE_MISMATCH"
      ) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new PurchaseError(
          "RPC_UNAVAILABLE",
          "The finalized domain state could not be read.",
        );
      }
      await sleep(intervalMs, input.signal);
      continue;
    }

    if (snapshot) return snapshot;

    if (attempt === maxAttempts) {
      throw new PurchaseError(
        "POST_STATE_MISMATCH",
        "The transaction finalized, but the expected domain state was not observed.",
      );
    }
    await sleep(intervalMs, input.signal);
  }

  throw new PurchaseError(
    "POST_STATE_MISMATCH",
    "The finalized domain state could not be verified.",
  );
}

interface TimeoutScope {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

function createTimeoutScope(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): TimeoutScope {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PurchaseError(
      "TRANSACTION_TIMEOUT",
      "The purchase timeout must be positive.",
    );
  }

  const controller = new AbortController();
  let didTimeOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
  }
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export interface PurchaseThruNameInput {
  label: string;
  years: number;
  payerTokenAccountAddress?: string;
}

export interface PurchaseThruNameOptions {
  timeoutMs?: number;
  postStateMaxAttempts?: number;
  postStateIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: PurchaseProgressStage) => void;
  dependencies?: PurchaseEngineDependencies;
}

export interface PurchaseThruNameResult {
  signature: string;
  price: bigint;
  payerTokenAccountAddress: string;
  postState: NameLookupSnapshot;
}

const ACTIVE_PURCHASES = new Set<string>();

function reportPurchaseProgress(
  onProgress: PurchaseThruNameOptions["onProgress"],
  stage: PurchaseProgressStage,
): void {
  try {
    onProgress?.(stage);
  } catch {
    // Progress observers must not be able to alter transaction safety.
  }
}

export async function purchaseThruName(
  account: ThruAccount,
  input: PurchaseThruNameInput,
  options: PurchaseThruNameOptions = {},
): Promise<PurchaseThruNameResult> {
  const validated = validatePurchaseLabel(input.label);
  const years = validatePurchaseYears(input.years);
  const walletAddress = validateWallet(account);
  const activeKey = `${walletAddress}\u0000${validated.label}`;
  if (ACTIVE_PURCHASES.has(activeKey)) {
    throw new PurchaseError(
      "TRANSACTION_REJECTED",
      "A purchase for this wallet and name is already in progress.",
    );
  }
  ACTIVE_PURCHASES.add(activeKey);

  const timeoutMs = options.timeoutMs ?? 60_000;
  let scope: TimeoutScope | undefined;
  try {
    scope = createTimeoutScope(timeoutMs, options.signal);
    const dependencies = options.dependencies ?? {};
    const lookupName = dependencies.lookupName ?? lookupThruName;
    const readTokenAccount =
      dependencies.readTokenAccount ?? defaultReadTokenAccount;
    const generateCreationProof =
      dependencies.generateCreationProof ?? defaultGenerateCreationProof;
    const buildTransaction =
      dependencies.buildTransaction ?? defaultBuildTransaction;
    const sendAndTrack = dependencies.sendAndTrack ?? defaultSendAndTrack;
    const sleep = dependencies.sleep ?? defaultSleep;
    const preparationInput: PreparePurchaseDomainInput = {
      label: validated.label,
      years,
      walletAddress,
      payerTokenAccountAddress: input.payerTokenAccountAddress,
      lookupName,
      readTokenAccount,
      signal: scope.signal,
    };

    reportPurchaseProgress(options.onProgress, "checking-availability");
    await preparePurchaseDomain(preparationInput);

    // Fresh availability/config read immediately before proof generation.
    reportPurchaseProgress(options.onProgress, "refreshing-price");
    const proofState = await resolvePurchaseDomain(preparationInput);
    reportPurchaseProgress(options.onProgress, "validating-payment-account");
    await validatePreparedPurchaseAccounts({
      prepared: proofState,
      readTokenAccount,
      signal: scope.signal,
    });
    reportPurchaseProgress(options.onProgress, "generating-state-proofs");
    const { leaseProof, domainProof } = await generateFreshProofs({
      prepared: proofState,
      generateCreationProof,
      signal: scope.signal,
    });
    const transaction = await abortable(
      buildPurchaseTransaction({
        prepared: proofState,
        walletPublicKey: account.publicKey,
        leaseProof,
        domainProof,
        buildTransaction,
        signal: scope.signal,
      }),
      scope.signal,
    );

    // Fresh availability/config/payment read immediately before local signing.
    const signingState = await preparePurchaseDomain(preparationInput);
    assertPreparedStateStable(proofState, signingState);
    throwIfAborted(scope.signal);
    reportPurchaseProgress(options.onProgress, "waiting-wallet-signature");
    try {
      await abortable(
        signTransactionForSubmission(transaction, account.privateKey),
        scope.signal,
      );
    } catch (error) {
      if (
        error instanceof PurchaseError &&
        error.code === "OPERATION_ABORTED"
      ) {
        throw error;
      }
      throw new PurchaseError(
        "TRANSACTION_BUILD_FAILED",
        "The purchase transaction could not be signed locally.",
      );
    }

    const submission = await submitAndTrackPurchase({
      transaction,
      sendAndTrack,
      timeoutMs,
      signal: scope.signal,
      onSubmitting: () =>
        reportPurchaseProgress(
          options.onProgress,
          "submitting-transaction",
        ),
      onConfirming: () =>
        reportPurchaseProgress(
          options.onProgress,
          "confirming-transaction",
        ),
    });
    let fallbackPostState: NameLookupSnapshot | null = null;
    if (!submission.trackingConfirmed) {
      try {
        const verification = await verifySubmittedTransaction({
          signature: submission.signature,
          verifyExpectedState: async () => {
            try {
              fallbackPostState = await observePurchasedDomain({
                label: signingState.label,
                expectedOwner: walletAddress,
                expected: signingState,
                lookupName,
                signal: scope?.signal,
              });
              return fallbackPostState !== null;
            } catch (error) {
              if (
                error instanceof PurchaseError &&
                error.code === "POST_STATE_MISMATCH"
              ) {
                throw error;
              }
              return false;
            }
          },
          classifyExpectedStateError: (error) =>
            error instanceof PurchaseError &&
            error.code === "POST_STATE_MISMATCH"
              ? "failure"
              : "pending",
          signal: scope.signal,
          timeoutMs: Math.min(
            TRANSACTION_FINALIZATION_FALLBACK_TIMEOUT_MS,
            Math.max(1, Math.floor(timeoutMs / 2)),
          ),
        });
        if (verification.outcome === "failure") {
          throw new PurchaseError(
            verification.source === "post-state"
              ? "POST_STATE_MISMATCH"
              : "TRANSACTION_REJECTED",
            verification.source === "post-state"
              ? "Final ownership could not be verified for the current wallet."
              : "The purchase transaction was rejected.",
          );
        }
      } catch (error) {
        if (error instanceof SubmittedTransactionUncertainError) {
          throw new PurchaseError(
            "TRANSACTION_TIMEOUT",
            SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
            error.signature,
          );
        }
        throw error;
      }
    }
    reportPurchaseProgress(options.onProgress, "verifying-ownership");
    const postState =
      fallbackPostState ??
      (await verifyPurchasedDomain({
        label: signingState.label,
        expectedOwner: walletAddress,
        expected: signingState,
        maxAttempts: options.postStateMaxAttempts,
        intervalMs: options.postStateIntervalMs,
        lookupName,
        sleep,
        signal: scope.signal,
      }));

    return {
      signature: submission.signature,
      price: signingState.price,
      payerTokenAccountAddress: signingState.payerTokenAccount,
      postState,
    };
  } catch (error) {
    if (scope?.timedOut()) {
      throw new PurchaseError(
        "TRANSACTION_TIMEOUT",
        "The purchase did not complete before the timeout.",
      );
    }
    if (options.signal?.aborted) throw safeAbortError();
    if (error instanceof PurchaseError) throw error;
    throw new PurchaseError(
      "TRANSACTION_REJECTED",
      "The purchase could not be completed.",
    );
  } finally {
    scope?.cleanup();
    ACTIVE_PURCHASES.delete(activeKey);
  }
}
