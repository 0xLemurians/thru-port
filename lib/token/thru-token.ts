import {
  ConsensusStatus,
  Filter,
  FilterParamValue,
  PageRequest,
  Pubkey,
  Signature,
  TransactionView,
  type Account,
  type Transaction,
} from "@thru/sdk";
import { StateProofType } from "@thru/sdk/proto";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import {
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  deriveMintAddress,
  deriveTokenAccountAddress,
  parseMintAccountData,
  parseTokenAccountData,
  type MintAccountInfo,
  type TokenAccountInfo,
} from "@thru/programs/token";
import {
  isAccountNotFoundError,
  thru,
  type ThruAccount,
} from "@/lib/wallet/thru-wallet";
import {
  AccountConsensusPendingError,
  accountReadFinality,
  assertFinalizedAccount,
  buildTransactionForSigning,
  signTransactionForSubmission,
  SubmittedTransactionUncertainError,
  submitSignedTransactionOnce,
  verifySubmittedTransaction,
} from "@/lib/thru/transactions";
import { THRU_NETWORK } from "@/lib/thru/network";
import {
  runTokenCreationWorkflow,
  runTokenMutationWorkflow,
  type TokenCreationProgress,
  type TokenMutationProgress,
  type TokenMutationStage,
} from "./workflow";
import {
  validateMintToPreflight,
  validateTransferPreflight,
  verifyMintToDeltas,
  verifyTransferDeltas,
} from "./operations";
import {
  MAX_KNOWN_MINTS,
  type KnownTokenRecord,
} from "./portfolio";
import {
  planTokenSetupResume,
  type TokenResumeProgress,
  type TokenResumeStage,
} from "./resume";
import {
  loadPendingSetups,
  pendingSetupsForWallet,
  type PendingTokenSetup,
} from "./pending-setup";
import {
  PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
  canonicalTokenOperationKey,
  clearPendingTokenOperation,
  loadPendingTokenOperations,
  pendingTokenOperationStorage,
  persistPendingTokenOperation,
  reconcilePendingTokenOperationJournal,
  type PendingTokenExpectedState,
  type PendingTokenOperationRecord,
  type PendingTokenOperationType,
} from "./pending-operation";
import {
  assertOfficialTokenProgramOwnership,
  buildDestinationInitializeAccountArgs,
  deriveDestinationTokenAccount,
  ensureDestinationTokenAccount,
  TokenProgramOwnershipError,
  type DestinationTokenAccountPreview,
} from "./destination-account";
import {
  decimalAmountToRaw,
  validateTokenDecimals,
  validateTokenInput,
  validateTokenTicker,
  type ValidatedTokenInput,
} from "./validation";
import {
  TRANSACTION_VISIBILITY_TIMEOUT_MS,
  TransactionStatusUncertainError,
  isTransactionNotFoundError,
} from "./transaction-status";

export const TOKEN_PROGRAM_ADDRESS = BOOTSTRAP_PROGRAM_ADDRESSES.token;
// Token instructions use the Betanet Token Program budget, not the much larger
// budget intended for deploying a program. Account-creating instructions add
// one state unit and use the slot of their fresh creation proof.
export const TOKEN_TRANSACTION_RESOURCES = Object.freeze({
  fee: 0n,
  expiryAfter: 100,
  computeUnits: 300_000,
  stateUnits: 0,
  memoryUnits: 10_000,
});

export function tokenCreationHeader(proofSlot: bigint) {
  if (typeof proofSlot !== "bigint" || proofSlot <= 0n) {
    throw new Error("The token creation proof slot is unavailable.");
  }
  return {
    ...TOKEN_TRANSACTION_RESOURCES,
    startSlot: proofSlot,
    stateUnits: 1,
  };
}
export const STALE_TOKEN_REFERENCE_MESSAGE =
  "The saved token is unavailable or belongs to another network or program deployment.";

const FINALIZATION_TIMEOUT_MS = 90_000;
const REFRESH_ATTEMPTS = 7;
const TOKEN_ACCOUNT_DEFAULT_SEED = new Uint8Array(32);
const ACTIVE_TOKEN_OPERATIONS = new Set<string>();

async function withTokenOperationGuard<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (ACTIVE_TOKEN_OPERATIONS.has(key)) {
    throw new Error("This token operation is already in progress.");
  }
  ACTIVE_TOKEN_OPERATIONS.add(key);
  try {
    return await operation();
  } finally {
    ACTIVE_TOKEN_OPERATIONS.delete(key);
  }
}

interface PendingOperationBase {
  key: string;
  operationType: PendingTokenOperationType;
  walletAddress: string;
  mintAddress: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
  recipientAddress?: string;
  amountRaw?: bigint;
  expectedPreState?: PendingTokenExpectedState;
  expectedPostState: PendingTokenExpectedState;
}

function pendingOperationRecord(
  base: PendingOperationBase,
  signature: string,
  createdAt = Date.now(),
): PendingTokenOperationRecord {
  return {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key: base.key,
    operationType: base.operationType,
    signature,
    walletAddress: base.walletAddress,
    mintAddress: base.mintAddress,
    ...(base.sourceTokenAccount
      ? { sourceTokenAccount: base.sourceTokenAccount }
      : {}),
    ...(base.destinationTokenAccount
      ? { destinationTokenAccount: base.destinationTokenAccount }
      : {}),
    ...(base.recipientAddress ? { recipientAddress: base.recipientAddress } : {}),
    ...(base.amountRaw !== undefined
      ? { amountRaw: base.amountRaw.toString(10) }
      : {}),
    ...(base.expectedPreState
      ? { expectedPreState: base.expectedPreState }
      : {}),
    expectedPostState: base.expectedPostState,
    createdAt,
    lastCheckedAt: createdAt,
    status: "submitted",
  };
}

function clearVerifiedPendingOperation(key: string, walletAddress: string): void {
  try {
    clearPendingTokenOperation(key, walletAddress);
  } catch {
    // Verified chain success remains success. A stale public record stays
    // fail-closed and can be reconciled/cleaned on a later safe read.
  }
}

/** @internal Reconciles public records before allowing another random mint seed. */
export async function reconcilePreviousTokenCreationBeforeNew(
  walletAddress: string,
  timeoutMs: number,
): Promise<void> {
  const storage = pendingTokenOperationStorage();
  const previous = loadPendingTokenOperations(storage).filter(
    (record) => record.walletAddress === walletAddress && (
      record.operationType === "create-mint" ||
      record.operationType === "create-token-account" ||
      record.operationType === "initial-supply"
    ),
  );
  for (const record of previous) {
    // This path is read-only. Resume token setup owns any subsequent writes.
    await reconcilePendingOperation({
      base: {
        key: record.key,
        operationType: record.operationType,
        walletAddress: record.walletAddress,
        mintAddress: record.mintAddress,
        expectedPostState: record.expectedPostState,
      },
      timeoutMs,
      verifyExpectedState: (current) =>
        matchesPendingTokenRecord(current, "finalized"),
      buildResult: async () => undefined,
      retainOnSuccess: true,
    });
  }
  const submittedSetup = pendingSetupsForWallet(
    loadPendingSetups(storage),
    walletAddress,
  ).some((setup) =>
    setup.mintSignature ||
    setup.tokenAccountSignature ||
    setup.initialSupplySignature,
  );
  if (previous.length > 0 || submittedSetup) {
    throw new Error(
      "A previous token setup has submitted transactions. Resume and verify that setup before creating another token.",
    );
  }
}

/** @internal Exact-signature, read-only journal reconciliation. */
export async function reconcilePendingOperation<TResult>(input: {
  base: PendingOperationBase;
  verifyExpectedState: (record: PendingTokenOperationRecord) => Promise<boolean>;
  buildResult: (
    signature: string,
    record: PendingTokenOperationRecord,
  ) => Promise<TResult>;
  timeoutMs: number;
  retainOnSuccess?: boolean;
}): Promise<{ outcome: "none" | "failure" } | { outcome: "success"; result: TResult }> {
  const reconciled = await reconcilePendingTokenOperationJournal({
    key: input.base.key,
    walletAddress: input.base.walletAddress,
    retainOnSuccess: true,
    verify: async (record) => {
      // A previously submitted operation may be CLUSTER_EXECUTED while its
      // exact point-account reads still say INCLUDED on Betanet. Only the
      // matching transaction status can authorize that provisional read.
      try {
        const status = await thru.transactions.getStatus(record.signature);
        if (Signature.from(status.signature).toThruFmt() !== record.signature) {
          return "uncertain";
        }
        if (status.executionResult && (
          status.executionResult.vmError !== 0 ||
          status.executionResult.userErrorCode !== 0n ||
          (status.executionResult.executionResult !== undefined &&
            status.executionResult.executionResult !== 0n)
        )) {
          return "failure";
        }
        if (
          status.executionResult &&
          (status.statusCode === ConsensusStatus.CLUSTER_EXECUTED ||
            status.statusCode === ConsensusStatus.FINALIZED)
        ) {
          return (await matchesPendingTokenRecord(record, "readable"))
            ? "success"
            : "uncertain";
        }
      } catch {
        // A missing or temporarily unavailable status is not a failed
        // transaction. Continue with the stricter finalized-only fallback.
      }
      try {
        const verification = await verifySubmittedTransaction({
          signature: record.signature,
          verifyExpectedState: () => input.verifyExpectedState(record),
          classifyExpectedStateError: classifyTokenPostStateError,
          timeoutMs: Math.min(
            input.timeoutMs,
            TRANSACTION_VISIBILITY_TIMEOUT_MS,
          ),
        });
        return verification.outcome;
      } catch {
        return "uncertain";
      }
    },
  });
  if (reconciled.outcome === "none" || reconciled.outcome === "failure") {
    return { outcome: reconciled.outcome };
  }
  if (reconciled.outcome === "uncertain") {
    throw new TransactionStatusUncertainError(
      reconciled.record.signature,
      false,
    );
  }
  const result = await input.buildResult(
    reconciled.record.signature,
    reconciled.record,
  );
  if (!input.retainOnSuccess) {
    clearVerifiedPendingOperation(input.base.key, input.base.walletAddress);
  }
  return { outcome: "success", result };
}

async function matchesPendingTokenRecord(
  record: PendingTokenOperationRecord,
  policy: "readable" | "finalized",
): Promise<boolean> {
  const mintRead = policy === "readable" ? getReadableMint : getVerifiedMint;
  const accountRead = policy === "readable"
    ? getReadableTokenAccount
    : getVerifiedTokenAccount;
  if (record.operationType === "create-mint") {
    return matchesPendingMintOnlyState(record, await mintRead(record.mintAddress));
  }
  if (record.operationType === "create-token-account" ||
      record.operationType === "destination-account") {
    if (!record.destinationTokenAccount) return false;
    return matchesPendingTokenAccountOnlyState(
      record,
      await accountRead(record.destinationTokenAccount),
    );
  }
  if (!record.destinationTokenAccount) return false;
  if (record.operationType === "transfer") {
    if (!record.sourceTokenAccount) return false;
    const [mint, source, destination] = await Promise.all([
      mintRead(record.mintAddress),
      accountRead(record.sourceTokenAccount),
      accountRead(record.destinationTokenAccount),
    ]);
    return matchesPendingTransferState(record, mint, source, destination);
  }
  const [mint, destination] = await Promise.all([
    mintRead(record.mintAddress),
    accountRead(record.destinationTokenAccount),
  ]);
  return matchesPendingMintDestinationState(record, mint, destination);
}

function expectedRaw(value: string | undefined): bigint | null {
  if (value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function matchesPendingMintDestinationState(
  record: PendingTokenOperationRecord,
  mint: MintAccountInfo,
  destination: TokenAccountInfo,
): boolean {
  const expected = record.expectedPostState;
  const mintSupply = expectedRaw(expected.mintSupply);
  const destinationBalance = expectedRaw(expected.destinationBalance);
  return (
    mintSupply !== null &&
    destinationBalance !== null &&
    mint.supply === mintSupply &&
    destination.amount === destinationBalance &&
    destination.mint === record.mintAddress &&
    (expected.mintDecimals === undefined ||
      mint.decimals === expected.mintDecimals) &&
    (expected.mintCreator === undefined ||
      mint.creator === expected.mintCreator) &&
    (expected.mintAuthority === undefined ||
      mint.mintAuthority === expected.mintAuthority) &&
    (expected.mintTicker === undefined || mint.ticker === expected.mintTicker) &&
    (expected.destinationOwner === undefined ||
      destination.owner === expected.destinationOwner) &&
    (expected.destinationFrozen === undefined ||
      destination.isFrozen === expected.destinationFrozen)
  );
}

function matchesPendingMintOnlyState(
  record: PendingTokenOperationRecord,
  mint: MintAccountInfo,
): boolean {
  const expected = record.expectedPostState;
  const mintSupply = expectedRaw(expected.mintSupply);
  return (
    mintSupply !== null &&
    mint.supply === mintSupply &&
    (expected.mintDecimals === undefined ||
      mint.decimals === expected.mintDecimals) &&
    (expected.mintCreator === undefined ||
      mint.creator === expected.mintCreator) &&
    (expected.mintAuthority === undefined ||
      mint.mintAuthority === expected.mintAuthority) &&
    (expected.mintTicker === undefined || mint.ticker === expected.mintTicker)
  );
}

function matchesPendingTokenAccountOnlyState(
  record: PendingTokenOperationRecord,
  tokenAccount: TokenAccountInfo,
): boolean {
  const expected = record.expectedPostState;
  const destinationBalance = expectedRaw(expected.destinationBalance);
  return (
    destinationBalance !== null &&
    tokenAccount.amount === destinationBalance &&
    tokenAccount.mint === record.mintAddress &&
    (expected.destinationOwner === undefined ||
      tokenAccount.owner === expected.destinationOwner) &&
    (expected.destinationFrozen === undefined ||
      tokenAccount.isFrozen === expected.destinationFrozen)
  );
}

function matchesPendingTransferState(
  record: PendingTokenOperationRecord,
  mint: MintAccountInfo,
  source: TokenAccountInfo,
  destination: TokenAccountInfo,
): boolean {
  const expected = record.expectedPostState;
  const mintSupply = expectedRaw(expected.mintSupply);
  const sourceBalance = expectedRaw(expected.sourceBalance);
  const destinationBalance = expectedRaw(expected.destinationBalance);
  return (
    mintSupply !== null &&
    sourceBalance !== null &&
    destinationBalance !== null &&
    mint.supply === mintSupply &&
    source.amount === sourceBalance &&
    destination.amount === destinationBalance &&
    source.mint === record.mintAddress &&
    destination.mint === record.mintAddress &&
    (expected.sourceOwner === undefined || source.owner === expected.sourceOwner) &&
    (expected.destinationOwner === undefined ||
      destination.owner === expected.destinationOwner) &&
    !source.isFrozen &&
    (expected.destinationFrozen === undefined ||
      destination.isFrozen === expected.destinationFrozen)
  );
}

export interface CreateTokenInput {
  name: string;
  ticker: string;
  decimals: number;
  initialSupply: string;
}

export interface CreateTokenOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress: (progress: TokenCreationProgress) => void;
}

export interface CreateTokenResult {
  name: string;
  ticker: string;
  decimals: number;
  initialSupplyRaw: bigint;
  mintAddress: string;
  tokenAccountAddress: string;
  mintSignature: string;
  tokenAccountSignature: string;
  initialSupplySignature: string;
  mint: MintAccountInfo;
  tokenAccount: TokenAccountInfo;
}

export interface TokenPortfolioAccount {
  address: string;
  state?: TokenAccountInfo;
  error?: string;
}

export interface TokenPortfolioItem {
  mintAddress: string;
  label?: string;
  walletAddress?: string;
  mint?: MintAccountInfo;
  error?: string;
  tokenAccounts: TokenPortfolioAccount[];
}

export interface ResumeTokenSetupInput {
  mintAddress: string;
  initialSupply: string;
}

export interface ResumeTokenSetupOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress: (progress: TokenResumeProgress) => void;
}

export interface ResumeTokenSetupResult {
  mintAddress: string;
  tokenAccountAddress: string;
  decimals: number;
  initialSupplyRaw: bigint;
  tokenAccountCreated: boolean;
  initialSupplyMinted: boolean;
  tokenAccountSignature?: string;
  initialSupplySignature?: string;
  mint: MintAccountInfo;
  tokenAccount: TokenAccountInfo;
}

export interface CreateDestinationTokenAccountInput {
  mintAddress: string;
  destinationOwnerAddress: string;
}

export interface CreateDestinationTokenAccountResult {
  mintAddress: string;
  destinationOwnerAddress: string;
  tokenAccountAddress: string;
  created: boolean;
  signature?: string;
  mint: MintAccountInfo;
  tokenAccount: TokenAccountInfo;
}

export interface TokenMutationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress: (progress: TokenMutationProgress) => void;
}

export interface MintAdditionalSupplyInput {
  mintAddress: string;
  destinationAddress: string;
  amount: string;
}

export interface MintAdditionalSupplyResult {
  signature: string;
  amountRaw: bigint;
  mintAddress: string;
  destinationAddress: string;
  mint: MintAccountInfo;
  destination: TokenAccountInfo;
}

export interface TransferTokenInput {
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
}

export interface TransferTokenResult {
  signature: string;
  amountRaw: bigint;
  mintAddress: string;
  sourceAddress: string;
  destinationAddress: string;
  mint: MintAccountInfo;
  source: TokenAccountInfo;
  destination: TokenAccountInfo;
}

/**
 * Input for a read-only token recovery check.
 * The UI collects only public on-chain addresses; no private data.
 */
export interface RecoverTokenInput {
  mintAddress: string;
  tokenAccountAddress: string;
  /** Display label, e.g. "MVP Test". */
  name: string;
  /** Ticker / symbol, e.g. "MVP". */
  ticker: string;
  /** The currently connected wallet address (owner check). */
  ownerAddress: string;
}

/** Result returned when on-chain verification succeeds for a recovery. */
export interface RecoverTokenResult {
  mintAddress: string;
  tokenAccountAddress: string;
  name: string;
  ticker: string;
  decimals: number;
  rawBalance: bigint;
  rawSupply: bigint;
  mint: MintAccountInfo;
  tokenAccount: TokenAccountInfo;
}

/**
 * Verify that a previously created token still exists on-chain with the
 * expected owner.  No transaction is ever submitted by this function.
 *
 * Throws a descriptive Error if any on-chain check fails.
 */
export async function verifyAndRecoverTokenOnBetanet(
  input: RecoverTokenInput,
  options: { signal?: AbortSignal } = {},
): Promise<RecoverTokenResult> {
  const { signal } = options;

  const mintAddress = canonicalAddressPublic(input.mintAddress, "Mint address");
  const tokenAccountAddress = canonicalAddressPublic(
    input.tokenAccountAddress,
    "Token account address",
  );
  const ownerAddress = canonicalAddressPublic(
    input.ownerAddress,
    "Owner address",
  );

  signal?.throwIfAborted();

  // 1. Fetch and verify mint account (must be owned by the official Token Program).
  const mint = await getVerifiedMint(mintAddress);

  signal?.throwIfAborted();

  // 2. Fetch and verify token account.
  const tokenAccount = await getVerifiedTokenAccount(tokenAccountAddress);

  signal?.throwIfAborted();

  // 3. Token account mint must match the supplied mint address.
  if (tokenAccount.mint !== mintAddress) {
    throw new Error(
      "The token account belongs to a different mint. " +
        `Expected ${mintAddress}, got ${tokenAccount.mint}.`,
    );
  }

  // 4. Token account owner must be the currently connected wallet.
  if (tokenAccount.owner !== ownerAddress) {
    throw new Error(
      "The token account owner does not match the connected wallet. " +
        "Only accounts you own can be recovered into your portfolio.",
    );
  }

  // 5. Token account must not be frozen.
  if (tokenAccount.isFrozen) {
    throw new Error(
      "The token account is frozen and cannot be added to the portfolio.",
    );
  }

  return {
    mintAddress,
    tokenAccountAddress,
    name: input.name.trim() || "Recovered Token",
    ticker: input.ticker.trim().toUpperCase() || "RCVR",
    decimals: mint.decimals,
    rawBalance: tokenAccount.amount,
    rawSupply: mint.supply,
    mint,
    tokenAccount,
  };
}

/** Internal helper that does NOT require the SDK `thru` client. */
function canonicalAddressPublic(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  try {
    return Pubkey.from(normalized).toThruFmt();
  } catch {
    throw new Error(`${label} is not a valid Thru address.`);
  }
}

interface TokenCreationContext {
  validated: ValidatedTokenInput;
  mint: ReturnType<typeof deriveMintAddress>;
  tokenAccount: ReturnType<typeof deriveTokenAccountAddress>;
  tokenAccountSeed: Uint8Array;
  mintSeedHex: string;
  verifiedMint?: MintAccountInfo;
  verifiedTokenAccount?: TokenAccountInfo;
}

export interface CreateTokenOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress: (progress: TokenCreationProgress) => void;
  /**
   * Optional hooks so that callers can persist/remove the pending-setup
   * record without this library depending on localStorage directly.
   */
  onPendingSetupAvailable?: (setup: Omit<PendingTokenSetup, "savedAt">) => void;
  onSetupComplete?: (mintAddress: string) => void;
}

export async function createTokenOnBetanet(
  account: ThruAccount,
  input: CreateTokenInput,
  options: CreateTokenOptions,
): Promise<CreateTokenResult> {
  const {
    signal,
    timeoutMs = FINALIZATION_TIMEOUT_MS,
    onProgress,
    onPendingSetupAvailable,
    onSetupComplete,
  } = options;
  let context: TokenCreationContext | null = null;
  let submissionOccurred = false;
  const pendingSignatures: Partial<
    Pick<
      PendingTokenSetup,
      "mintSignature" | "tokenAccountSignature" | "initialSupplySignature"
    >
  > = {};

  const getContext = (): TokenCreationContext => {
    if (!context) {
      throw new Error("Token creation context is unavailable.");
    }
    return context;
  };

  const reportPendingSetup = (): void => {
    const current = getContext();
    onPendingSetupAvailable?.({
      walletAddress: account.address,
      mintAddress: current.mint.address,
      tokenAccountAddress: current.tokenAccount.address,
      name: current.validated.name,
      ticker: current.validated.ticker,
      decimals: current.validated.decimals,
      initialSupply: input.initialSupply,
      ...pendingSignatures,
    });
  };

  const workflowResult = await withTokenOperationGuard(
    `create-token:${account.address}`,
    () => runTokenCreationWorkflow(
    {
      validate: async () => {
        signal?.throwIfAborted();
        const validated = validateTokenInput(input);
        await assertActiveWalletExists(account.address, signal);
        await reconcilePreviousTokenCreationBeforeNew(account.address, timeoutMs);
        signal?.throwIfAborted();

        const mintSeedHex = randomSeedHex();
        const mint = deriveMintAddress(
          thru,
          account.address,
          mintSeedHex,
          TOKEN_PROGRAM_ADDRESS,
        );
        const tokenAccountSeed = TOKEN_ACCOUNT_DEFAULT_SEED.slice();
        const tokenAccount = deriveTokenAccountAddress(
          thru,
          account.address,
          mint.address,
          TOKEN_PROGRAM_ADDRESS,
          tokenAccountSeed,
        );

        await assertAccountDoesNotExist(mint.address);
        await assertAccountDoesNotExist(tokenAccount.address);
        context = {
          validated,
          mint,
          tokenAccount,
          tokenAccountSeed,
          mintSeedHex,
        };
        // Persist the pending setup as soon as addresses are known.
        // This allows recovery even if final verification times out.
        reportPendingSetup();
      },

      createMint: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
        const operationKey = canonicalTokenOperationKey({
          operationType: "create-mint",
          walletAddress: account.address,
          mintAddress: current.mint.address,
        });
        const operationBase: PendingOperationBase = {
          key: operationKey,
          operationType: "create-mint",
          walletAddress: account.address,
          mintAddress: current.mint.address,
          expectedPostState: {
            mintSupply: "0",
            mintDecimals: current.validated.decimals,
            mintCreator: account.address,
            mintAuthority: account.address,
            mintTicker: current.validated.ticker,
          },
        };
        const reconciled = await reconcilePendingOperation({
          base: operationBase,
          timeoutMs,
          verifyExpectedState: (record) =>
            observeMintState(record.mintAddress, (mint) =>
              matchesPendingMintOnlyState(record, mint),
            ),
          buildResult: async (signature, record) => {
            // The journal's exact transaction was authoritatively verified;
            // Betanet may still return INCLUDED for its point-account read.
            current.verifiedMint = await getReadableMint(record.mintAddress);
            if (!matchesPendingMintOnlyState(record, current.verifiedMint)) {
              throw new TransactionStatusUncertainError(signature, false);
            }
            pendingSignatures.mintSignature = signature;
            reportPendingSetup();
            onSubmitted(signature);
            return { signature };
          },
        });
        if (reconciled.outcome === "success") return reconciled.result;

        const stateProof = await thru.proofs.generate({
          address: current.mint.address,
          proofType: StateProofType.CREATING,
        });
        signal?.throwIfAborted();

        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [current.mint.address],
          },
          header: tokenCreationHeader(stateProof.slot),
          instructionData: createInitializeMintInstruction({
            mintAccountBytes: current.mint.bytes,
            decimals: current.validated.decimals,
            creatorBytes: account.publicKey,
            mintAuthorityBytes: account.publicKey,
            ticker: current.validated.ticker,
            seedHex: current.mintSeedHex,
            stateProof: stateProof.proof,
          }),
        }, signal);

        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          (submittedSignature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(operationBase, submittedSignature),
            );
            submissionOccurred = true;
            pendingSignatures.mintSignature = submittedSignature;
            reportPendingSetup();
            onSubmitted(submittedSignature);
          },
          timeoutMs,
          signal,
          {
            verifyExpectedState: () =>
              observeMintState(
                current.mint.address,
                (mint) =>
                  mint.decimals === current.validated.decimals &&
                  mint.ticker === current.validated.ticker &&
                  mint.creator === account.address &&
                  mint.mintAuthority === account.address &&
                  mint.supply === 0n &&
                  mint.freezeAuthority === null &&
                  !mint.hasFreezeAuthority,
              ),
          },
        );

        await waitForMintState(
          current.mint.address,
          (mint) =>
            mint.decimals === current.validated.decimals &&
            mint.ticker === current.validated.ticker &&
            mint.creator === account.address &&
            mint.mintAuthority === account.address &&
            mint.supply === 0n &&
            mint.freezeAuthority === null &&
              !mint.hasFreezeAuthority,
          undefined,
          "The finalized mint state did not match the requested configuration.",
          signature,
        );

        clearVerifiedPendingOperation(operationKey, account.address);

        return { signature };
      },

      createTokenAccount: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
        const operationKey = canonicalTokenOperationKey({
          operationType: "create-token-account",
          walletAddress: account.address,
          mintAddress: current.mint.address,
          destinationTokenAccount: current.tokenAccount.address,
          recipientAddress: account.address,
        });
        const operationBase: PendingOperationBase = {
          key: operationKey,
          operationType: "create-token-account",
          walletAddress: account.address,
          mintAddress: current.mint.address,
          destinationTokenAccount: current.tokenAccount.address,
          recipientAddress: account.address,
          expectedPostState: {
            destinationBalance: "0",
            destinationOwner: account.address,
            destinationFrozen: false,
          },
        };
        const reconciled = await reconcilePendingOperation({
          base: operationBase,
          timeoutMs,
          verifyExpectedState: (record) =>
            observeTokenAccountState(
              record.destinationTokenAccount!,
              (tokenAccount) =>
                matchesPendingTokenAccountOnlyState(record, tokenAccount),
            ),
          buildResult: async (signature, record) => {
            current.verifiedTokenAccount = await getReadableTokenAccount(
              record.destinationTokenAccount!,
            );
            if (
              !matchesPendingTokenAccountOnlyState(
                record,
                current.verifiedTokenAccount,
              )
            ) {
              throw new TransactionStatusUncertainError(signature, false);
            }
            pendingSignatures.tokenAccountSignature = signature;
            reportPendingSetup();
            onSubmitted(signature);
            return { signature };
          },
        });
        if (reconciled.outcome === "success") return reconciled.result;

        await assertAccountDoesNotExist(current.tokenAccount.address);
        const stateProof = await thru.proofs.generate({
          address: current.tokenAccount.address,
          proofType: StateProofType.CREATING,
        });
        signal?.throwIfAborted();

        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [current.tokenAccount.address],
            readOnly: [current.mint.address],
          },
          header: tokenCreationHeader(stateProof.slot),
          instructionData: createInitializeAccountInstruction({
            tokenAccountBytes: current.tokenAccount.bytes,
            mintAccountBytes: current.mint.bytes,
            ownerAccountBytes: account.publicKey,
            seedBytes: current.tokenAccountSeed,
            stateProof: stateProof.proof,
          }),
        }, signal);

        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          (submittedSignature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(operationBase, submittedSignature),
            );
            submissionOccurred = true;
            pendingSignatures.tokenAccountSignature = submittedSignature;
            reportPendingSetup();
            onSubmitted(submittedSignature);
          },
          timeoutMs,
          signal,
          {
            verifyExpectedState: () =>
              observeTokenAccountState(
                current.tokenAccount.address,
                (tokenAccount) =>
                  tokenAccount.mint === current.mint.address &&
                  tokenAccount.owner === account.address &&
                  tokenAccount.amount === 0n &&
                  !tokenAccount.isFrozen,
              ),
          },
        );

        await waitForTokenAccountState(
          current.tokenAccount.address,
          (tokenAccount) =>
            tokenAccount.mint === current.mint.address &&
            tokenAccount.owner === account.address &&
            tokenAccount.amount === 0n &&
            !tokenAccount.isFrozen,
          undefined,
          "The finalized token account state did not match its mint and owner.",
          signature,
        );

        clearVerifiedPendingOperation(operationKey, account.address);

        return { signature };
      },

      mintInitialSupply: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
        const operationKey = canonicalTokenOperationKey({
          operationType: "initial-supply",
          walletAddress: account.address,
          mintAddress: current.mint.address,
          destinationTokenAccount: current.tokenAccount.address,
          recipientAddress: account.address,
          amountRaw: current.validated.initialSupplyRaw,
        });
        const operationBase: PendingOperationBase = {
          key: operationKey,
          operationType: "initial-supply",
          walletAddress: account.address,
          mintAddress: current.mint.address,
          destinationTokenAccount: current.tokenAccount.address,
          recipientAddress: account.address,
          amountRaw: current.validated.initialSupplyRaw,
          expectedPostState: {
            mintSupply: current.validated.initialSupplyRaw.toString(10),
            destinationBalance:
              current.validated.initialSupplyRaw.toString(10),
            destinationOwner: account.address,
            destinationFrozen: false,
          },
        };
        const reconciled = await reconcilePendingOperation({
          base: operationBase,
          timeoutMs,
          verifyExpectedState: async (record) => {
            const [mint, tokenAccount] = await Promise.all([
              getVerifiedMint(record.mintAddress),
              getVerifiedTokenAccount(record.destinationTokenAccount!),
            ]);
            return matchesPendingMintDestinationState(
              record,
              mint,
              tokenAccount,
            );
          },
          buildResult: async (signature, record) => {
            [current.verifiedMint, current.verifiedTokenAccount] =
              await Promise.all([
                getReadableMint(record.mintAddress),
                getReadableTokenAccount(record.destinationTokenAccount!),
              ]);
            if (
              !matchesPendingMintDestinationState(
                record,
                current.verifiedMint,
                current.verifiedTokenAccount,
              )
            ) {
              throw new TransactionStatusUncertainError(signature, false);
            }
            pendingSignatures.initialSupplySignature = signature;
            reportPendingSetup();
            onSubmitted(signature);
            return { signature };
          },
        });
        if (reconciled.outcome === "success") return reconciled.result;

        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [
              current.mint.address,
              current.tokenAccount.address,
            ],
          },
          header: { ...TOKEN_TRANSACTION_RESOURCES },
          instructionData: createMintToInstruction({
            mintAccountBytes: current.mint.bytes,
            destinationAccountBytes: current.tokenAccount.bytes,
            authorityAccountBytes: account.publicKey,
            amount: current.validated.initialSupplyRaw,
          }),
        }, signal);

        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          (submittedSignature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(operationBase, submittedSignature),
            );
            submissionOccurred = true;
            pendingSignatures.initialSupplySignature = submittedSignature;
            reportPendingSetup();
            onSubmitted(submittedSignature);
          },
          timeoutMs,
          signal,
          {
            verifyExpectedState: async () => {
              const [mintObserved, accountObserved] = await Promise.all([
                observeMintState(
                  current.mint.address,
                  (mint) =>
                    mint.supply === current.validated.initialSupplyRaw,
                ),
                observeTokenAccountState(
                  current.tokenAccount.address,
                  (tokenAccount) =>
                    tokenAccount.mint === current.mint.address &&
                    tokenAccount.owner === account.address &&
                    tokenAccount.amount ===
                      current.validated.initialSupplyRaw &&
                    !tokenAccount.isFrozen,
                ),
              ]);
              return mintObserved && accountObserved;
            },
          },
        );
        return { signature };
      },

      verifyOnChainState: async () => {
        if (!submissionOccurred) signal?.throwIfAborted();
        const current = getContext();
        const [verifiedMint, verifiedTokenAccount] = await Promise.all([
          waitForMintState(
            current.mint.address,
            (mint) =>
              mint.decimals === current.validated.decimals &&
              mint.ticker === current.validated.ticker &&
              mint.creator === account.address &&
              mint.mintAuthority === account.address &&
              mint.supply === current.validated.initialSupplyRaw &&
              mint.freezeAuthority === null &&
              !mint.hasFreezeAuthority,
            submissionOccurred ? undefined : signal,
            "Mint supply or authority did not match after finalization.",
            pendingSignatures.initialSupplySignature,
          ),
          waitForTokenAccountState(
            current.tokenAccount.address,
            (tokenAccount) =>
              tokenAccount.mint === current.mint.address &&
              tokenAccount.owner === account.address &&
              tokenAccount.amount === current.validated.initialSupplyRaw &&
              !tokenAccount.isFrozen,
            submissionOccurred ? undefined : signal,
            "Token account balance did not match the initial supply.",
            pendingSignatures.initialSupplySignature,
          ),
        ]);
        current.verifiedMint = verifiedMint;
        current.verifiedTokenAccount = verifiedTokenAccount;
        clearVerifiedPendingOperation(
          canonicalTokenOperationKey({
            operationType: "initial-supply",
            walletAddress: account.address,
            mintAddress: current.mint.address,
            destinationTokenAccount: current.tokenAccount.address,
            recipientAddress: account.address,
            amountRaw: current.validated.initialSupplyRaw,
          }),
          account.address,
        );
      },
    },
    onProgress,
    ),
  );

  const current = getContext();
  if (!current.verifiedMint || !current.verifiedTokenAccount) {
    throw new Error("Verified on-chain token state is unavailable.");
  }

  // Verification succeeded — the pending setup can be cleared.
  onSetupComplete?.(current.mint.address);

  return {
    name: current.validated.name,
    ticker: current.validated.ticker,
    decimals: current.validated.decimals,
    initialSupplyRaw: current.validated.initialSupplyRaw,
    mintAddress: current.mint.address,
    tokenAccountAddress: current.tokenAccount.address,
    mintSignature: workflowResult.mint.signature,
    tokenAccountSignature: workflowResult.tokenAccount.signature,
    initialSupplySignature: workflowResult.initialSupply.signature,
    mint: current.verifiedMint,
    tokenAccount: current.verifiedTokenAccount,
  };
}

export async function fetchTokenPortfolioOnBetanet(
  records: KnownTokenRecord[],
  options: { signal?: AbortSignal } = {},
): Promise<TokenPortfolioItem[]> {
  const { signal } = options;
  return Promise.all(
    records.map(async (record): Promise<TokenPortfolioItem> => {
      signal?.throwIfAborted();
      const mintResult = await settleTokenRead(() =>
        getReadableMint(record.mintAddress),
      );
      const tokenAccounts = await Promise.all(
        record.tokenAccountAddresses.map(
          async (address): Promise<TokenPortfolioAccount> => {
            signal?.throwIfAborted();
            const result = await settleTokenRead(() =>
              getReadableTokenAccount(address),
            );
            signal?.throwIfAborted();
            if (!result.value) {
              return { address, error: result.error };
            }
            if (result.value.mint !== record.mintAddress) {
              return {
                address,
                state: result.value,
                error: "This token account belongs to a different mint.",
              };
            }
            return { address, state: result.value };
          },
        ),
      );
      signal?.throwIfAborted();
      return {
        mintAddress: record.mintAddress,
        ...(record.label ? { label: record.label } : {}),
        ...(record.walletAddress ? { walletAddress: record.walletAddress } : {}),
        ...(mintResult.value
          ? { mint: mintResult.value }
          : { error: mintResult.error }),
        tokenAccounts,
      };
    }),
  );
}

const DISCOVERY_PAGE_SIZE = 32;
const MAX_DISCOVERY_TRANSACTIONS = 128;
const MAX_DISCOVERY_CANDIDATES = 128;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 12_000;

interface DiscoveryTransaction {
  program: Pubkey;
  readWriteAccounts: Pubkey[];
}

interface DiscoveryTransactionPage {
  transactions: DiscoveryTransaction[];
  nextPageToken?: string;
}

export interface CreatedTokenDiscoveryDependencies {
  listTransactionsForAccount: (
    walletAddress: string,
    pageToken: string | undefined,
    pageSize: number,
  ) => Promise<DiscoveryTransactionPage>;
  getAccount: (address: string) => Promise<Account>;
}

export interface CreatedTokenDiscoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTransactions?: number;
  maxCandidates?: number;
  maxResults?: number;
  dependencies?: CreatedTokenDiscoveryDependencies;
}

const defaultCreatedTokenDiscoveryDependencies: CreatedTokenDiscoveryDependencies =
  {
    async listTransactionsForAccount(walletAddress, pageToken, pageSize) {
      const result = await thru.transactions.listForAccount(walletAddress, {
        filter: new Filter({
          expression:
            "transaction.header.program_pubkey.value == params.pubkey",
          params: {
            pubkey: FilterParamValue.pubkey(TOKEN_PROGRAM_ADDRESS),
          },
        }),
        page: new PageRequest({ pageSize, pageToken }),
        transactionOptions: {
          view: TransactionView.HEADER_AND_BODY,
          minConsensus: ConsensusStatus.FINALIZED,
        },
      });
      return {
        transactions: result.transactions,
        nextPageToken: result.page?.nextPageToken,
      };
    },
    async getAccount(address) {
      const account = await thru.accounts.get(address);
      accountReadFinality(account);
      return account;
    },
  };

export async function discoverControlledTokensOnBetanet(
  walletAddress: string,
  options: CreatedTokenDiscoveryOptions = {},
): Promise<KnownTokenRecord[]> {
  const canonicalWallet = canonicalAddress(walletAddress, "Wallet address");
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    1,
    60_000,
  );
  const maxTransactions = boundedInteger(
    options.maxTransactions,
    MAX_DISCOVERY_TRANSACTIONS,
    1,
    MAX_DISCOVERY_TRANSACTIONS,
  );
  const maxCandidates = boundedInteger(
    options.maxCandidates,
    MAX_DISCOVERY_CANDIDATES,
    1,
    MAX_DISCOVERY_CANDIDATES,
  );
  const maxResults = boundedInteger(
    options.maxResults,
    MAX_KNOWN_MINTS,
    1,
    MAX_KNOWN_MINTS,
  );
  const dependencies =
    options.dependencies ?? defaultCreatedTokenDiscoveryDependencies;
  const deadline = Date.now() + timeoutMs;
  const candidateAddresses = new Set<string>();
  let pageToken: string | undefined;
  let transactionCount = 0;

  do {
    throwIfDiscoveryStopped(options.signal, deadline);
    const remaining = maxTransactions - transactionCount;
    const page = await awaitDiscoveryStep(
      dependencies.listTransactionsForAccount(
        canonicalWallet,
        pageToken,
        Math.min(DISCOVERY_PAGE_SIZE, remaining),
      ),
      options.signal,
      deadline,
    );
    const transactions = page.transactions.slice(0, remaining);
    transactionCount += transactions.length;

    for (const transaction of transactions) {
      if (transaction.program.toThruFmt() !== TOKEN_PROGRAM_ADDRESS) continue;
      for (const address of transaction.readWriteAccounts) {
        candidateAddresses.add(address.toThruFmt());
        if (candidateAddresses.size >= maxCandidates) break;
      }
      if (candidateAddresses.size >= maxCandidates) break;
    }

    const nextPageToken = page.nextPageToken;
    if (
      transactions.length === 0 ||
      !nextPageToken ||
      nextPageToken === pageToken
    ) {
      pageToken = undefined;
      break;
    }
    pageToken = nextPageToken;
  } while (
    pageToken &&
    transactionCount < maxTransactions &&
    candidateAddresses.size < maxCandidates
  );

  const discovered: KnownTokenRecord[] = [];
  for (const mintAddress of candidateAddresses) {
    throwIfDiscoveryStopped(options.signal, deadline);
    let mint: MintAccountInfo;
    try {
      mint = await awaitDiscoveryStep(
        getVerifiedMintWith(dependencies.getAccount, mintAddress),
        options.signal,
        deadline,
      );
      if (!isStructurallyValidMint(mint)) continue;
      if (
        mint.creator !== canonicalWallet &&
        mint.mintAuthority !== canonicalWallet
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const tokenAccountAddresses: string[] = [];
    const derivedTokenAccount = deriveTokenAccountAddress(
      thru,
      canonicalWallet,
      mintAddress,
      TOKEN_PROGRAM_ADDRESS,
      TOKEN_ACCOUNT_DEFAULT_SEED,
    ).address;
    try {
      const tokenAccount = await awaitDiscoveryStep(
        getVerifiedTokenAccountWith(
          dependencies.getAccount,
          derivedTokenAccount,
        ),
        options.signal,
        deadline,
      );
      if (
        tokenAccount.mint === mintAddress &&
        tokenAccount.owner === canonicalWallet
      ) {
        tokenAccountAddresses.push(derivedTokenAccount);
      }
    } catch {
      // A mint remains a controlled token even without a current token account.
    }

    discovered.push({
      mintAddress,
      walletAddress: canonicalWallet,
      creatorAddress: mint.creator,
      mintAuthorityAddress: mint.mintAuthority,
      ticker: mint.ticker,
      decimals: mint.decimals,
      tokenAccountAddresses,
    });
    if (discovered.length >= maxResults) break;
  }
  return discovered;
}

export function isCreatedTokenControlledByWallet(
  item: TokenPortfolioItem,
  walletAddress: string,
): boolean {
  return Boolean(
    item.mint &&
      isStructurallyValidMint(item.mint) &&
      (item.mint.creator === walletAddress ||
        item.mint.mintAuthority === walletAddress),
  );
}

export async function resumeTokenSetupOnBetanet(
  account: ThruAccount,
  input: ResumeTokenSetupInput,
  options: ResumeTokenSetupOptions,
): Promise<ResumeTokenSetupResult> {
  const { signal, timeoutMs = FINALIZATION_TIMEOUT_MS, onProgress } = options;
  let currentStage: Exclude<TokenResumeStage, "failed" | "uncertain"> =
    "validating";
  let mintAddress = "";
  let tokenAccountAddress = "";
  let initialSupplyRaw: bigint | null = null;
  let mint: MintAccountInfo | null = null;
  let tokenAccount: TokenAccountInfo | null = null;
  let tokenAccountSignature: string | undefined;
  let initialSupplySignature: string | undefined;
  let tokenAccountCreated = false;
  let initialSupplyMinted = false;

  const progress = (
    stage: Exclude<TokenResumeStage, "failed" | "uncertain">,
    details: Omit<TokenResumeProgress, "stage"> = {},
  ) => {
    currentStage = stage;
    onProgress({ stage, ...details });
  };

  try {
    progress("validating");
    signal?.throwIfAborted();
    mintAddress = canonicalAddress(input.mintAddress, "Mint address");
    await assertActiveWalletExists(account.address, signal);
    const createMintOperationKey = canonicalTokenOperationKey({
      operationType: "create-mint",
      walletAddress: account.address,
      mintAddress,
    });
    const createMintReconciliation = await reconcilePendingOperation({
      base: {
        key: createMintOperationKey,
        operationType: "create-mint",
        walletAddress: account.address,
        mintAddress,
        expectedPostState: {},
      },
      timeoutMs,
      verifyExpectedState: (record) =>
        observeMintState(record.mintAddress, (nextMint) =>
          matchesPendingMintOnlyState(record, nextMint),
        ),
      buildResult: async (signature, record) => {
        const nextMint = await getReadableMint(record.mintAddress);
        if (!matchesPendingMintOnlyState(record, nextMint)) {
          throw new TransactionStatusUncertainError(signature, false);
        }
        return nextMint;
      },
    });
    mint = createMintReconciliation.outcome === "success"
      ? createMintReconciliation.result
      : await getVerifiedMint(mintAddress);
    initialSupplyRaw = decimalAmountToRaw(
      input.initialSupply,
      mint.decimals,
      undefined,
      "Initial supply",
    );

    const tokenAccountSeed = TOKEN_ACCOUNT_DEFAULT_SEED.slice();
    const derivedTokenAccount = deriveTokenAccountAddress(
      thru,
      account.address,
      mintAddress,
      TOKEN_PROGRAM_ADDRESS,
      tokenAccountSeed,
    );
    tokenAccountAddress = derivedTokenAccount.address;
    const tokenAccountOperationKey = canonicalTokenOperationKey({
      operationType: "create-token-account",
      walletAddress: account.address,
      mintAddress,
      destinationTokenAccount: tokenAccountAddress,
      recipientAddress: account.address,
    });
    const tokenAccountOperationBase: PendingOperationBase = {
      key: tokenAccountOperationKey,
      operationType: "create-token-account",
      walletAddress: account.address,
      mintAddress,
      destinationTokenAccount: tokenAccountAddress,
      recipientAddress: account.address,
      expectedPostState: {
        destinationBalance: "0",
        destinationOwner: account.address,
        destinationFrozen: false,
      },
    };
    const tokenAccountReconciliation = await reconcilePendingOperation({
      base: tokenAccountOperationBase,
      timeoutMs,
      verifyExpectedState: (record) =>
        observeTokenAccountState(
          record.destinationTokenAccount!,
          (nextTokenAccount) =>
            matchesPendingTokenAccountOnlyState(record, nextTokenAccount),
        ),
      buildResult: async (signature, record) => {
        const nextTokenAccount = await getReadableTokenAccount(
          record.destinationTokenAccount!,
        );
        if (!matchesPendingTokenAccountOnlyState(record, nextTokenAccount)) {
          throw new TransactionStatusUncertainError(signature, false);
        }
        return { signature, tokenAccount: nextTokenAccount };
      },
    });
    if (tokenAccountReconciliation.outcome === "success") {
      tokenAccountSignature = tokenAccountReconciliation.result.signature;
      tokenAccount = tokenAccountReconciliation.result.tokenAccount;
      tokenAccountCreated = true;
    } else {
      tokenAccount = await getOptionalVerifiedTokenAccount(tokenAccountAddress);
    }
    let plan = planTokenSetupResume({
      mintAddress,
      ownerAddress: account.address,
      mint,
      tokenAccount,
    });

    progress("ensuring-token-account", {
      detail: plan.createTokenAccount
        ? "The deterministic token account is missing and will be created."
        : "The deterministic token account already exists; creation is skipped.",
    });

    if (plan.createTokenAccount) {
      signal?.throwIfAborted();
      tokenAccount = await getOptionalVerifiedTokenAccount(tokenAccountAddress);
      plan = planTokenSetupResume({
        mintAddress,
        ownerAddress: account.address,
        mint,
        tokenAccount,
      });

      if (plan.createTokenAccount) {
        const stateProof = await thru.proofs.generate({
          address: tokenAccountAddress,
          proofType: StateProofType.CREATING,
        });
        signal?.throwIfAborted();
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [tokenAccountAddress],
            readOnly: [mintAddress],
          },
          header: tokenCreationHeader(stateProof.slot),
          instructionData: createInitializeAccountInstruction({
            tokenAccountBytes: derivedTokenAccount.bytes,
            mintAccountBytes: Pubkey.from(mintAddress).toBytes(),
            ownerAccountBytes: account.publicKey,
            seedBytes: tokenAccountSeed,
            stateProof: stateProof.proof,
          }),
        }, signal);
        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        tokenAccountSignature = await submitAndRequireFinalizedExecution(
          transaction,
          (signature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(tokenAccountOperationBase, signature),
            );
            progress("waiting-account-finalization", {
              signature,
              transactionKind: "token-account",
            });
          },
          timeoutMs,
          signal,
          {
            verifyExpectedState: () =>
              observeTokenAccountState(
                tokenAccountAddress,
                (state) =>
                  state.mint === mintAddress &&
                  state.owner === account.address &&
                  state.amount === 0n &&
                  !state.isFrozen,
              ),
          },
        );
        tokenAccount = await waitForTokenAccountState(
          tokenAccountAddress,
          (state) =>
            state.mint === mintAddress &&
            state.owner === account.address &&
            state.amount === 0n &&
            !state.isFrozen,
          signal,
          "The resumed token account did not match its mint and owner.",
          tokenAccountSignature,
        );
        clearVerifiedPendingOperation(
          tokenAccountOperationKey,
          account.address,
        );
        tokenAccountCreated = true;
      }
    }

    mint = await getReadableMint(mintAddress);
    tokenAccount =
      tokenAccount ?? (await getVerifiedTokenAccount(tokenAccountAddress));
    const rawInitialSupply = requireValue(initialSupplyRaw, "Initial supply");
    const initialSupplyOperationKey = canonicalTokenOperationKey({
      operationType: "initial-supply",
      walletAddress: account.address,
      mintAddress,
      destinationTokenAccount: tokenAccountAddress,
      recipientAddress: account.address,
      amountRaw: rawInitialSupply,
    });
    const initialSupplyOperationBase: PendingOperationBase = {
      key: initialSupplyOperationKey,
      operationType: "initial-supply",
      walletAddress: account.address,
      mintAddress,
      destinationTokenAccount: tokenAccountAddress,
      recipientAddress: account.address,
      amountRaw: rawInitialSupply,
      expectedPostState: {
        mintSupply: rawInitialSupply.toString(10),
        destinationBalance: rawInitialSupply.toString(10),
        destinationOwner: account.address,
        destinationFrozen: false,
      },
    };
    const initialSupplyReconciliation = await reconcilePendingOperation({
      base: initialSupplyOperationBase,
      timeoutMs,
      verifyExpectedState: async (record) => {
        const [nextMint, nextTokenAccount] = await Promise.all([
          getVerifiedMint(record.mintAddress),
          getVerifiedTokenAccount(record.destinationTokenAccount!),
        ]);
        return matchesPendingMintDestinationState(
          record,
          nextMint,
          nextTokenAccount,
        );
      },
      buildResult: async (signature, record) => {
        const [nextMint, nextTokenAccount] = await Promise.all([
          getReadableMint(record.mintAddress),
          getReadableTokenAccount(record.destinationTokenAccount!),
        ]);
        if (
          !matchesPendingMintDestinationState(
            record,
            nextMint,
            nextTokenAccount,
          )
        ) {
          throw new TransactionStatusUncertainError(signature, false);
        }
        return { signature, mint: nextMint, tokenAccount: nextTokenAccount };
      },
    });
    if (initialSupplyReconciliation.outcome === "success") {
      initialSupplySignature = initialSupplyReconciliation.result.signature;
      mint = initialSupplyReconciliation.result.mint;
      tokenAccount = initialSupplyReconciliation.result.tokenAccount;
      initialSupplyMinted = true;
    }
    plan = planTokenSetupResume({
      mintAddress,
      ownerAddress: account.address,
      mint,
      tokenAccount,
    });

    progress("minting-initial-supply", {
      detail: plan.mintInitialSupply
        ? "Mint supply is zero; the confirmed initial supply will be minted."
        : "Mint supply is already non-zero; initial supply minting is skipped.",
    });

    if (plan.mintInitialSupply) {
      signal?.throwIfAborted();
      const rawAmount = rawInitialSupply;
      const beforeMint = mint;
      const beforeTokenAccount = tokenAccount;
      const transaction = await buildTransactionForSigning({
        feePayer: { publicKey: account.publicKey },
        program: TOKEN_PROGRAM_ADDRESS,
        accounts: {
          readWrite: [mintAddress, tokenAccountAddress],
        },
        header: { ...TOKEN_TRANSACTION_RESOURCES },
        instructionData: createMintToInstruction({
          mintAccountBytes: Pubkey.from(mintAddress).toBytes(),
          destinationAccountBytes: Pubkey.from(tokenAccountAddress).toBytes(),
          authorityAccountBytes: account.publicKey,
          amount: rawAmount,
        }),
      }, signal);
      await signTransactionForSubmission(
        transaction,
        account.privateKey,
        signal,
      );
      initialSupplySignature = await submitAndRequireFinalizedExecution(
        transaction,
        (signature) => {
          persistPendingTokenOperation(
            pendingOperationRecord(initialSupplyOperationBase, signature),
          );
          progress("waiting-supply-finalization", {
            signature,
            transactionKind: "initial-supply",
          });
        },
        timeoutMs,
        signal,
        {
          verifyExpectedState: async () => {
            const [nextMint, nextTokenAccount] = await Promise.all([
              getVerifiedMint(mintAddress),
              getVerifiedTokenAccount(tokenAccountAddress),
            ]);
            return mutationMatches(() =>
              verifyMintToDeltas({
                amount: rawAmount,
                beforeMint,
                afterMint: nextMint,
                beforeDestination: beforeTokenAccount,
                afterDestination: nextTokenAccount,
              }),
            );
          },
        },
      );
      const verified = await waitForParsedState(
        async () => {
          const [nextMint, nextTokenAccount] = await Promise.all([
            getReadableMint(mintAddress),
            getReadableTokenAccount(tokenAccountAddress),
          ]);
          return { mint: nextMint, tokenAccount: nextTokenAccount };
        },
        (state) =>
          mutationMatches(() =>
            verifyMintToDeltas({
              amount: rawAmount,
              beforeMint,
              afterMint: state.mint,
              beforeDestination: beforeTokenAccount,
              afterDestination: state.tokenAccount,
            }),
          ),
        signal,
        "Mint supply or token balance did not reflect the resumed initial supply.",
        initialSupplySignature,
      );
      verifyMintToDeltas({
        amount: rawAmount,
        beforeMint,
        afterMint: verified.mint,
        beforeDestination: beforeTokenAccount,
        afterDestination: verified.tokenAccount,
      });
      mint = verified.mint;
      tokenAccount = verified.tokenAccount;
      clearVerifiedPendingOperation(
        initialSupplyOperationKey,
        account.address,
      );
      initialSupplyMinted = true;
    }

    progress("verifying-on-chain-state");
    [mint, tokenAccount] = await Promise.all([
      initialSupplyMinted ? getReadableMint(mintAddress) : getVerifiedMint(mintAddress),
      initialSupplyMinted
        ? getReadableTokenAccount(tokenAccountAddress)
        : getVerifiedTokenAccount(tokenAccountAddress),
    ]);
    planTokenSetupResume({
      mintAddress,
      ownerAddress: account.address,
      mint,
      tokenAccount,
    });

    progress("completed");
    return {
      mintAddress,
      tokenAccountAddress,
      decimals: mint.decimals,
      initialSupplyRaw: requireValue(initialSupplyRaw, "Initial supply"),
      tokenAccountCreated,
      initialSupplyMinted,
      ...(tokenAccountSignature ? { tokenAccountSignature } : {}),
      ...(initialSupplySignature ? { initialSupplySignature } : {}),
      mint,
      tokenAccount,
    };
  } catch (error) {
    if (error instanceof TransactionStatusUncertainError) {
      onProgress({
        stage: "uncertain",
        uncertainAt: currentStage,
        signature: error.signature,
        error: error.message,
        expectedStateObserved: error.expectedStateObserved,
      });
      throw error;
    }
    onProgress({
      stage: "failed",
      failedAt: currentStage,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function previewDestinationTokenAccount(
  input: CreateDestinationTokenAccountInput,
): DestinationTokenAccountPreview {
  return deriveDestinationTokenAccount(thru, {
    ...input,
    tokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
  });
}

export async function createDestinationTokenAccountOnBetanet(
  account: ThruAccount,
  input: CreateDestinationTokenAccountInput,
  options: TokenMutationOptions,
): Promise<CreateDestinationTokenAccountResult> {
  const { signal, timeoutMs = FINALIZATION_TIMEOUT_MS, onProgress } = options;
  let currentStage: Exclude<TokenMutationStage, "failed" | "uncertain"> =
    "validating";
  let activeSignature: string | undefined;
  const progress = (
    stage: Exclude<TokenMutationStage, "failed" | "uncertain">,
    details: Omit<TokenMutationProgress, "stage"> = {},
  ) => {
    currentStage = stage;
    onProgress({ stage, ...details });
  };

  try {
    progress("validating");
    signal?.throwIfAborted();
    const preview = previewDestinationTokenAccount(input);
    if (preview.destinationOwnerAddress === account.address) {
      throw new Error(
        "Destination owner must differ from the active wallet. Use Resume token setup for the active wallet.",
      );
    }
    await assertActiveWalletExists(account.address, signal);
    const mint = await getVerifiedMint(preview.mintAddress);
    const operationKey = canonicalTokenOperationKey({
      operationType: "destination-account",
      walletAddress: account.address,
      mintAddress: preview.mintAddress,
      destinationTokenAccount: preview.tokenAccountAddress,
      recipientAddress: preview.destinationOwnerAddress,
    });
    const operationBase: PendingOperationBase = {
      key: operationKey,
      operationType: "destination-account",
      walletAddress: account.address,
      mintAddress: preview.mintAddress,
      destinationTokenAccount: preview.tokenAccountAddress,
      recipientAddress: preview.destinationOwnerAddress,
      expectedPostState: {
        destinationBalance: "0",
        destinationOwner: preview.destinationOwnerAddress,
        destinationFrozen: false,
      },
    };

    const ensured = await withTokenOperationGuard(
      operationKey,
      async () => {
        const reconciled = await reconcilePendingOperation({
          base: operationBase,
          timeoutMs,
          verifyExpectedState: (record) =>
            observeTokenAccountState(
              record.destinationTokenAccount!,
              (tokenAccount) =>
                matchesPendingTokenAccountOnlyState(record, tokenAccount),
            ),
          buildResult: async (signature, record) => {
            const tokenAccount = await getReadableTokenAccount(
              record.destinationTokenAccount!,
            );
            if (!matchesPendingTokenAccountOnlyState(record, tokenAccount)) {
              throw new TransactionStatusUncertainError(signature, false);
            }
            return {
              tokenAccount,
              created: true,
              signature,
              existenceChecks: 0,
            };
          },
        });
        if (reconciled.outcome === "success") return reconciled.result;

        const result = await ensureDestinationTokenAccount(
      {
        tokenAccountAddress: preview.tokenAccountAddress,
        mintAddress: preview.mintAddress,
        destinationOwnerAddress: preview.destinationOwnerAddress,
      },
      {
        readOptionalTokenAccount: async (address) => {
          signal?.throwIfAborted();
          return getOptionalVerifiedTokenAccount(address);
        },
        createTokenAccount: async () => {
          signal?.throwIfAborted();
          progress("building-transaction");
          const stateProof = await thru.proofs.generate({
            address: preview.tokenAccountAddress,
            proofType: StateProofType.CREATING,
          });
          signal?.throwIfAborted();
          const transaction = await buildTransactionForSigning({
            feePayer: { publicKey: account.publicKey },
            program: TOKEN_PROGRAM_ADDRESS,
            accounts: {
              readWrite: [preview.tokenAccountAddress],
              readOnly: [
                preview.mintAddress,
                preview.destinationOwnerAddress,
              ],
            },
            header: tokenCreationHeader(stateProof.slot),
            instructionData: createInitializeAccountInstruction(
              buildDestinationInitializeAccountArgs({
                preview,
                stateProof: stateProof.proof,
              }),
            ),
          }, signal);
          await signTransactionForSubmission(
            transaction,
            account.privateKey,
            signal,
          );
          return submitAndRequireFinalizedExecution(
            transaction,
            (signature) => {
              persistPendingTokenOperation(
                pendingOperationRecord(operationBase, signature),
              );
              activeSignature = signature;
              progress("waiting-final-consensus", { signature });
            },
            timeoutMs,
            signal,
            {
              onFinalConsensus: () => {
                progress("verifying-execution", {
                  signature: activeSignature,
                });
              },
              verifyExpectedState: () =>
                observeTokenAccountState(
                  preview.tokenAccountAddress,
                  (tokenAccount) =>
                    tokenAccount.mint === preview.mintAddress &&
                    tokenAccount.owner ===
                      preview.destinationOwnerAddress &&
                    tokenAccount.amount === 0n &&
                    !tokenAccount.isFrozen,
                ),
            },
          );
        },
        readCreatedTokenAccount: (address) => {
          progress("refetching-on-chain-state", {
            signature: activeSignature,
          });
          return waitForTokenAccountState(
            address,
            (tokenAccount) =>
              tokenAccount.mint === preview.mintAddress &&
              tokenAccount.owner === preview.destinationOwnerAddress &&
              tokenAccount.amount === 0n &&
              !tokenAccount.isFrozen,
            activeSignature ? undefined : signal,
            "The created destination token account did not match its mint, owner, zero balance, or frozen state.",
            activeSignature,
          );
        },
      },
        );
        clearVerifiedPendingOperation(operationKey, account.address);
        return result;
      },
    );

    progress("completed", {
      ...(ensured.signature ? { signature: ensured.signature } : {}),
    });
    return {
      mintAddress: preview.mintAddress,
      destinationOwnerAddress: preview.destinationOwnerAddress,
      tokenAccountAddress: preview.tokenAccountAddress,
      created: ensured.created,
      ...(ensured.signature ? { signature: ensured.signature } : {}),
      mint,
      tokenAccount: ensured.tokenAccount,
    };
  } catch (error) {
    if (error instanceof TransactionStatusUncertainError) {
      onProgress({
        stage: "uncertain",
        uncertainAt: currentStage,
        signature: error.signature,
        error: error.message,
        expectedStateObserved: error.expectedStateObserved,
      });
      throw error;
    }
    onProgress({
      stage: "failed",
      failedAt: currentStage,
      error: error instanceof Error ? error.message : String(error),
      ...(activeSignature ? { signature: activeSignature } : {}),
    });
    throw error;
  }
}

export async function mintAdditionalSupplyOnBetanet(
  account: ThruAccount,
  input: MintAdditionalSupplyInput,
  options: TokenMutationOptions,
): Promise<MintAdditionalSupplyResult> {
  const { signal, timeoutMs = FINALIZATION_TIMEOUT_MS, onProgress } = options;
  const mintAddress = canonicalAddress(input.mintAddress, "Mint address");
  const destinationAddress = canonicalAddress(
    input.destinationAddress,
    "Destination token account",
  );
  let beforeMint: MintAccountInfo | null = null;
  let beforeDestination: TokenAccountInfo | null = null;
  let amountRaw: bigint | null = null;
  let afterMint: MintAccountInfo | null = null;
  let afterDestination: TokenAccountInfo | null = null;
  let activeSignature: string | undefined;

  onProgress({ stage: "validating" });
  signal?.throwIfAborted();
  await assertActiveWalletExists(account.address, signal);
  [beforeMint, beforeDestination] = await Promise.all([
    getVerifiedMint(mintAddress),
    getVerifiedTokenAccount(destinationAddress),
  ]);
  amountRaw = decimalAmountToRaw(
    input.amount,
    beforeMint.decimals,
    undefined,
    "Amount",
  );
  const rawAmount = requireValue(amountRaw, "Mint amount");
  const operationKey = canonicalTokenOperationKey({
    operationType: "mint-additional",
    walletAddress: account.address,
    mintAddress,
    destinationTokenAccount: destinationAddress,
    amountRaw: rawAmount,
  });
  const operationBase: PendingOperationBase = {
    key: operationKey,
    operationType: "mint-additional",
    walletAddress: account.address,
    mintAddress,
    destinationTokenAccount: destinationAddress,
    amountRaw: rawAmount,
    expectedPreState: {
      mintSupply: beforeMint.supply.toString(10),
      destinationBalance: beforeDestination.amount.toString(10),
    },
    expectedPostState: {
      mintSupply: (beforeMint.supply + rawAmount).toString(10),
      mintDecimals: beforeMint.decimals,
      mintCreator: beforeMint.creator,
      mintAuthority: beforeMint.mintAuthority,
      mintTicker: beforeMint.ticker,
      destinationBalance: (beforeDestination.amount + rawAmount).toString(10),
      destinationOwner: beforeDestination.owner,
      destinationFrozen: beforeDestination.isFrozen,
    },
  };

  const result = await withTokenOperationGuard(
    operationKey,
    async () => {
      const reconciled = await reconcilePendingOperation({
        base: operationBase,
        timeoutMs,
        verifyExpectedState: async (record) => {
          const [mint, destination] = await Promise.all([
            getVerifiedMint(record.mintAddress),
            getVerifiedTokenAccount(record.destinationTokenAccount!),
          ]);
          return matchesPendingMintDestinationState(record, mint, destination);
        },
        buildResult: async (signature, record) => {
          const [mint, destination] = await Promise.all([
            getReadableMint(record.mintAddress),
            getReadableTokenAccount(record.destinationTokenAccount!),
          ]);
          if (!matchesPendingMintDestinationState(record, mint, destination)) {
            throw new TransactionStatusUncertainError(signature, false);
          }
          afterMint = mint;
          afterDestination = destination;
          activeSignature = signature;
          onProgress({ stage: "completed", signature });
          return { signature, result: { mint, destination } };
        },
      });
      if (reconciled.outcome === "success") return reconciled.result;

      amountRaw = validateMintToPreflight({
        mintAddress,
        destinationAddress,
        activeWalletAddress: account.address,
        amount: input.amount,
        mint: requireValue(beforeMint, "Mint preflight state"),
        destination: requireValue(
          beforeDestination,
          "Destination preflight state",
        ),
      });

      try {
        const workflow = await runTokenMutationWorkflow(
      {
      validate: async () => {
        signal?.throwIfAborted();
      },
      execute: async (callbacks) => {
        signal?.throwIfAborted();
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [mintAddress, destinationAddress],
          },
          header: { ...TOKEN_TRANSACTION_RESOURCES },
          instructionData: createMintToInstruction({
            mintAccountBytes: Pubkey.from(mintAddress).toBytes(),
            destinationAccountBytes: Pubkey.from(destinationAddress).toBytes(),
            authorityAccountBytes: account.publicKey,
            amount: rawAmount,
          }),
        }, signal);
        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        callbacks.onAwaitingFinalConsensus();
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          (submittedSignature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(operationBase, submittedSignature),
            );
            activeSignature = submittedSignature;
            callbacks.onSubmitted(submittedSignature);
          },
          timeoutMs,
          signal,
          {
            onFinalConsensus: callbacks.onFinalConsensus,
            verifyExpectedState: async () => {
              const mint = requireValue(beforeMint, "Mint preflight state");
              const destination = requireValue(
                beforeDestination,
                "Destination preflight state",
              );
              const [nextMint, nextDestination] = await Promise.all([
                getVerifiedMint(mintAddress),
                getVerifiedTokenAccount(destinationAddress),
              ]);
              return mutationMatches(() =>
                verifyMintToDeltas({
                  amount: rawAmount,
                  beforeMint: mint,
                  afterMint: nextMint,
                  beforeDestination: destination,
                  afterDestination: nextDestination,
                }),
              );
            },
          },
        );
        return { signature };
      },
      refetchAndVerify: async () => {
        const mint = requireValue(beforeMint, "Mint preflight state");
        const destination = requireValue(
          beforeDestination,
          "Destination preflight state",
        );
        const verified = await waitForParsedState(
          async () => {
            const [nextMint, nextDestination] = await Promise.all([
              getReadableMint(mintAddress),
              getReadableTokenAccount(destinationAddress),
            ]);
            return { mint: nextMint, destination: nextDestination };
          },
          (next) =>
            mutationMatches(() =>
              verifyMintToDeltas({
                amount: rawAmount,
                beforeMint: mint,
                afterMint: next.mint,
                beforeDestination: destination,
                afterDestination: next.destination,
              }),
            ),
          activeSignature ? undefined : signal,
          "Mint supply or destination balance did not reflect the additional supply.",
          activeSignature,
        );
        verifyMintToDeltas({
          amount: rawAmount,
          beforeMint: mint,
          afterMint: verified.mint,
          beforeDestination: destination,
          afterDestination: verified.destination,
        });
        afterMint = verified.mint;
        afterDestination = verified.destination;
        return verified;
      },
    },
    onProgress,
        );
        clearVerifiedPendingOperation(operationKey, account.address);
        return workflow;
      } catch (error) {
        if (!(error instanceof TransactionStatusUncertainError)) {
          clearPendingTokenOperation(operationKey, account.address);
        }
        throw error;
      }
    },
  );

  return {
    signature: result.signature,
    amountRaw: requireValue<bigint>(amountRaw, "Mint amount"),
    mintAddress,
    destinationAddress,
    mint: requireValue<MintAccountInfo>(afterMint, "Verified mint state"),
    destination: requireValue<TokenAccountInfo>(
      afterDestination,
      "Verified destination token state",
    ),
  };
}

export async function transferTokensOnBetanet(
  account: ThruAccount,
  input: TransferTokenInput,
  options: TokenMutationOptions,
): Promise<TransferTokenResult> {
  const { signal, timeoutMs = FINALIZATION_TIMEOUT_MS, onProgress } = options;
  const sourceAddress = canonicalAddress(
    input.sourceAddress,
    "Source token account",
  );
  const destinationAddress = canonicalAddress(
    input.destinationAddress,
    "Destination token account",
  );
  let beforeMint: MintAccountInfo | null = null;
  let beforeSource: TokenAccountInfo | null = null;
  let beforeDestination: TokenAccountInfo | null = null;
  let amountRaw: bigint | null = null;
  let afterMint: MintAccountInfo | null = null;
  let afterSource: TokenAccountInfo | null = null;
  let afterDestination: TokenAccountInfo | null = null;
  let mintAddress = "";
  let activeSignature: string | undefined;

  onProgress({ stage: "validating" });
  signal?.throwIfAborted();
  await assertActiveWalletExists(account.address, signal);
  [beforeSource, beforeDestination] = await Promise.all([
    getVerifiedTokenAccount(sourceAddress),
    getVerifiedTokenAccount(destinationAddress),
  ]);
  mintAddress = beforeSource.mint;
  beforeMint = await getVerifiedMint(mintAddress);
  amountRaw = decimalAmountToRaw(
    input.amount,
    beforeMint.decimals,
    undefined,
    "Amount",
  );
  const rawAmount = requireValue(amountRaw, "Transfer amount");
  const operationKey = canonicalTokenOperationKey({
    operationType: "transfer",
    walletAddress: account.address,
    mintAddress,
    sourceTokenAccount: sourceAddress,
    destinationTokenAccount: destinationAddress,
    recipientAddress: beforeDestination.owner,
    amountRaw: rawAmount,
  });
  const operationBase: PendingOperationBase = {
    key: operationKey,
    operationType: "transfer",
    walletAddress: account.address,
    mintAddress,
    sourceTokenAccount: sourceAddress,
    destinationTokenAccount: destinationAddress,
    recipientAddress: beforeDestination.owner,
    amountRaw: rawAmount,
    expectedPreState: {
      mintSupply: beforeMint.supply.toString(10),
      sourceBalance: beforeSource.amount.toString(10),
      destinationBalance: beforeDestination.amount.toString(10),
    },
    expectedPostState: {
      mintSupply: beforeMint.supply.toString(10),
      sourceBalance: (beforeSource.amount - rawAmount).toString(10),
      sourceOwner: beforeSource.owner,
      destinationBalance: (beforeDestination.amount + rawAmount).toString(10),
      destinationOwner: beforeDestination.owner,
      destinationFrozen: beforeDestination.isFrozen,
    },
  };

  const result = await withTokenOperationGuard(
    operationKey,
    async () => {
      const reconciled = await reconcilePendingOperation({
        base: operationBase,
        timeoutMs,
        verifyExpectedState: async (record) => {
          const [mint, source, destination] = await Promise.all([
            getVerifiedMint(record.mintAddress),
            getVerifiedTokenAccount(record.sourceTokenAccount!),
            getVerifiedTokenAccount(record.destinationTokenAccount!),
          ]);
          return matchesPendingTransferState(record, mint, source, destination);
        },
        buildResult: async (signature, record) => {
          const [mint, source, destination] = await Promise.all([
            getReadableMint(record.mintAddress),
            getReadableTokenAccount(record.sourceTokenAccount!),
            getReadableTokenAccount(record.destinationTokenAccount!),
          ]);
          if (!matchesPendingTransferState(record, mint, source, destination)) {
            throw new TransactionStatusUncertainError(signature, false);
          }
          afterMint = mint;
          afterSource = source;
          afterDestination = destination;
          activeSignature = signature;
          onProgress({ stage: "completed", signature });
          return { signature, result: { mint, source, destination } };
        },
      });
      if (reconciled.outcome === "success") return reconciled.result;

      amountRaw = validateTransferPreflight({
        mintAddress,
        sourceAddress,
        destinationAddress,
        activeWalletAddress: account.address,
        amount: input.amount,
        mint: requireValue(beforeMint, "Mint preflight state"),
        source: requireValue(beforeSource, "Source preflight state"),
        destination: requireValue(
          beforeDestination,
          "Destination preflight state",
        ),
      });

      try {
        const workflow = await runTokenMutationWorkflow(
      {
      validate: async () => {
        signal?.throwIfAborted();
      },
      execute: async (callbacks) => {
        signal?.throwIfAborted();
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [sourceAddress, destinationAddress],
          },
          header: { ...TOKEN_TRANSACTION_RESOURCES },
          instructionData: createTransferInstruction({
            sourceAccountBytes: Pubkey.from(sourceAddress).toBytes(),
            destinationAccountBytes: Pubkey.from(destinationAddress).toBytes(),
            amount: rawAmount,
          }),
        }, signal);
        await signTransactionForSubmission(
          transaction,
          account.privateKey,
          signal,
        );
        callbacks.onAwaitingFinalConsensus();
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          (submittedSignature) => {
            persistPendingTokenOperation(
              pendingOperationRecord(operationBase, submittedSignature),
            );
            activeSignature = submittedSignature;
            callbacks.onSubmitted(submittedSignature);
          },
          timeoutMs,
          signal,
          {
            onFinalConsensus: callbacks.onFinalConsensus,
            verifyExpectedState: async () => {
              const mint = requireValue(beforeMint, "Mint preflight state");
              const source = requireValue(
                beforeSource,
                "Source preflight state",
              );
              const destination = requireValue(
                beforeDestination,
                "Destination preflight state",
              );
              const [nextMint, nextSource, nextDestination] = await Promise.all([
                getVerifiedMint(mintAddress),
                getVerifiedTokenAccount(sourceAddress),
                getVerifiedTokenAccount(destinationAddress),
              ]);
              return mutationMatches(() =>
                verifyTransferDeltas({
                  amount: rawAmount,
                  beforeMint: mint,
                  afterMint: nextMint,
                  beforeSource: source,
                  afterSource: nextSource,
                  beforeDestination: destination,
                  afterDestination: nextDestination,
                }),
              );
            },
          },
        );
        return { signature };
      },
      refetchAndVerify: async () => {
        const mint = requireValue(beforeMint, "Mint preflight state");
        const source = requireValue(beforeSource, "Source preflight state");
        const destination = requireValue(
          beforeDestination,
          "Destination preflight state",
        );
        const verified = await waitForParsedState(
          async () => {
            const [nextMint, nextSource, nextDestination] = await Promise.all([
              getReadableMint(mintAddress),
              getReadableTokenAccount(sourceAddress),
              getReadableTokenAccount(destinationAddress),
            ]);
            return {
              mint: nextMint,
              source: nextSource,
              destination: nextDestination,
            };
          },
          (next) =>
            mutationMatches(() =>
              verifyTransferDeltas({
                amount: rawAmount,
                beforeMint: mint,
                afterMint: next.mint,
                beforeSource: source,
                afterSource: next.source,
                beforeDestination: destination,
                afterDestination: next.destination,
              }),
            ),
          activeSignature ? undefined : signal,
          "Transfer balances or mint supply did not match the submitted amount.",
          activeSignature,
        );
        verifyTransferDeltas({
          amount: rawAmount,
          beforeMint: mint,
          afterMint: verified.mint,
          beforeSource: source,
          afterSource: verified.source,
          beforeDestination: destination,
          afterDestination: verified.destination,
        });
        afterMint = verified.mint;
        afterSource = verified.source;
        afterDestination = verified.destination;
        return verified;
      },
    },
    onProgress,
        );
        clearVerifiedPendingOperation(operationKey, account.address);
        return workflow;
      } catch (error) {
        if (!(error instanceof TransactionStatusUncertainError)) {
          clearPendingTokenOperation(operationKey, account.address);
        }
        throw error;
      }
    },
  );

  return {
    signature: result.signature,
    amountRaw: requireValue<bigint>(amountRaw, "Transfer amount"),
    mintAddress,
    sourceAddress,
    destinationAddress,
    mint: requireValue<MintAccountInfo>(afterMint, "Verified mint state"),
    source: requireValue<TokenAccountInfo>(
      afterSource,
      "Verified source token state",
    ),
    destination: requireValue<TokenAccountInfo>(
      afterDestination,
      "Verified destination token state",
    ),
  };
}

async function assertActiveWalletExists(
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    const wallet = await thru.accounts.get(address);
    // Eligibility read only: INCLUDED is usable, but never proves a submitted
    // token transaction succeeded.
    accountReadFinality(wallet);
    if (wallet.meta?.flags.isDeleted) {
      throw new Error(
        `The active wallet account is deleted on ${THRU_NETWORK.displayName}.`,
      );
    }
  } catch (error) {
    if (isAccountNotFoundError(error)) {
      throw new Error(
        "The active wallet does not exist on-chain yet. Return to Wallet & Faucet and fund it first.",
      );
    }
    throw error;
  }
}

async function assertAccountDoesNotExist(address: string): Promise<void> {
  try {
    await thru.accounts.get(address);
  } catch (error) {
    if (isAccountNotFoundError(error)) return;
    throw error;
  }
  throw new Error(
    "A derived token address already exists. Start the token creation flow again.",
  );
}

/** @internal Token submission boundary; never retries the signed wire. */
export async function submitAndRequireFinalizedExecution(
  transaction: Transaction,
  onSubmitted: (signature: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
  tracking: {
    onFinalConsensus?: () => void;
    verifyExpectedState?: () => Promise<boolean>;
  } = {},
): Promise<string> {
  const { onFinalConsensus, verifyExpectedState } = tracking;
  signal?.throwIfAborted();
  const signature = transaction.getSignature()?.toThruFmt() ?? "";
  if (!signature) throw new Error("The signed token transaction has no signature.");
  const wire = transaction.toWire();
  // Persist public recovery metadata before transport. A storage failure
  // fails closed; after this point cancellation cannot prove non-submission.
  onSubmitted(signature);
  let statusResult: Awaited<ReturnType<typeof submitSignedTransactionOnce>>;
  try {
    statusResult = await submitSignedTransactionOnce({
      rawTransaction: wire,
      expectedSignature: signature,
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof SubmittedTransactionUncertainError) {
      throw new TransactionStatusUncertainError(error.signature, false);
    }
    throw error;
  }
  if (statusResult.failure) {
    throw new TokenTransactionExecutionError(
      statusResult.failure.vmError,
      statusResult.failure.userErrorCode,
    );
  }
  if (statusResult.finalized && statusResult.executionSucceeded) {
    onFinalConsensus?.();
    return signature;
  }
  // The unary status endpoint may lag or omit execution details. Reconcile
  // read-only by the original signature and exact expected state, never send.
  try {
    const verification = await verifySubmittedTransaction({
      signature,
      verifyExpectedState,
      classifyExpectedStateError: classifyTokenPostStateError,
      timeoutMs: Math.min(
        timeoutMs,
        TRANSACTION_VISIBILITY_TIMEOUT_MS,
      ),
    });
    if (verification.outcome === "failure") {
      throw new Error(
        "Token transaction execution or post-state verification failed.",
      );
    }
  } catch (error) {
    if (error instanceof SubmittedTransactionUncertainError) {
      throw new TransactionStatusUncertainError(
        error.signature,
        error.expectedStateObserved,
      );
    }
    throw error;
  }
  onFinalConsensus?.();
  return signature;
}

export class TokenTransactionExecutionError extends Error {
  constructor(
    readonly vmError: number,
    readonly userErrorCode: bigint,
  ) {
    super("Token transaction execution failed.");
    this.name = "TokenTransactionExecutionError";
  }
}

function classifyTokenPostStateError(
  error: unknown,
): "pending" | "failure" {
  if (isAccountNotFoundError(error) || isTransactionNotFoundError(error)) {
    return "pending";
  }
  if (error instanceof AccountConsensusPendingError) return "pending";
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:rpc|grpc|proxy|upstream|transport|connection|disconnect|reset|refused|unavailable|socket|network|timeout|fetch)\b/i.test(
    message,
  )
    ? "pending"
    : "failure";
}

async function getVerifiedMint(address: string): Promise<MintAccountInfo> {
  const account = await getTokenProgramAccount(address, "finalized");
  return parseMintAccountData(account);
}

async function getReadableMint(address: string): Promise<MintAccountInfo> {
  const account = await getTokenProgramAccount(address, "readable");
  return parseMintAccountData(account);
}

async function getVerifiedTokenAccount(
  address: string,
): Promise<TokenAccountInfo> {
  const account = await getTokenProgramAccount(address, "finalized");
  return parseTokenAccountData(account);
}

async function getReadableTokenAccount(
  address: string,
): Promise<TokenAccountInfo> {
  const account = await getTokenProgramAccount(address, "readable");
  return parseTokenAccountData(account);
}

async function getOptionalVerifiedTokenAccount(
  address: string,
): Promise<TokenAccountInfo | null> {
  try {
    return await getVerifiedTokenAccount(address);
  } catch (error) {
    if (isAccountNotFoundError(error)) return null;
    throw error;
  }
}

export async function observeMintState(
  address: string,
  matches: (mint: MintAccountInfo) => boolean,
): Promise<boolean> {
  try {
    const mint = await getVerifiedMint(address);
    if (!matches(mint)) return false;
    return true;
  } catch (error) {
    if (isAccountNotFoundError(error)) return false;
    throw error;
  }
}

export async function observeTokenAccountState(
  address: string,
  matches: (tokenAccount: TokenAccountInfo) => boolean,
): Promise<boolean> {
  try {
    const tokenAccount = await getVerifiedTokenAccount(address);
    if (!matches(tokenAccount)) return false;
    return true;
  } catch (error) {
    if (isAccountNotFoundError(error)) return false;
    throw error;
  }
}

async function getTokenProgramAccount(
  address: string,
  policy: "readable" | "finalized",
): Promise<Account> {
  const account = await thru.accounts.get(address);
  if (account.address?.toThruFmt() !== address) {
    throw new Error("The returned token account address did not match the requested address.");
  }
  if (policy === "finalized") {
    assertFinalizedAccount(account);
  } else {
    accountReadFinality(account);
  }
  const owner = account.meta?.owner?.toThruFmt();
  assertOfficialTokenProgramOwnership(owner, TOKEN_PROGRAM_ADDRESS, address);
  return account;
}

async function getTokenProgramAccountWith(
  getAccount: (address: string) => Promise<Account>,
  address: string,
): Promise<Account> {
  const account = await getAccount(address);
  const owner = account.meta?.owner?.toThruFmt();
  assertOfficialTokenProgramOwnership(owner, TOKEN_PROGRAM_ADDRESS, address);
  return account;
}

async function getVerifiedMintWith(
  getAccount: (address: string) => Promise<Account>,
  address: string,
): Promise<MintAccountInfo> {
  const account = await getTokenProgramAccountWith(getAccount, address);
  return parseMintAccountData(account);
}

async function getVerifiedTokenAccountWith(
  getAccount: (address: string) => Promise<Account>,
  address: string,
): Promise<TokenAccountInfo> {
  const account = await getTokenProgramAccountWith(getAccount, address);
  return parseTokenAccountData(account);
}

function isStructurallyValidMint(mint: MintAccountInfo): boolean {
  try {
    return (
      validateTokenTicker(mint.ticker) === mint.ticker &&
      validateTokenDecimals(mint.decimals) === mint.decimals &&
      Pubkey.from(mint.creator).toThruFmt() === mint.creator &&
      Pubkey.from(mint.mintAuthority).toThruFmt() === mint.mintAuthority
    );
  } catch {
    return false;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function throwIfDiscoveryStopped(
  signal: AbortSignal | undefined,
  deadline: number,
): void {
  if (signal?.aborted) {
    throw new Error("Token discovery was cancelled.");
  }
  if (Date.now() >= deadline) {
    throw new Error("Token discovery timed out.");
  }
}

async function awaitDiscoveryStep<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<T> {
  throwIfDiscoveryStopped(signal, deadline);
  const remaining = Math.max(1, deadline - Date.now());
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Token discovery timed out.")),
      remaining,
    );
    const abort = () => reject(new Error("Token discovery was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    });
  });
}

async function settleTokenRead<T>(
  read: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    if (error instanceof TokenProgramOwnershipError) {
      return { error: STALE_TOKEN_REFERENCE_MESSAGE };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function canonicalAddress(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  try {
    return Pubkey.from(normalized).toThruFmt();
  } catch {
    throw new Error(`${label} is not a valid Thru address.`);
  }
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`${label} is unavailable.`);
  }
  return value;
}

function mutationMatches(verify: () => void): boolean {
  try {
    verify();
    return true;
  } catch {
    return false;
  }
}

async function waitForMintState(
  address: string,
  matches: (mint: MintAccountInfo) => boolean,
  signal: AbortSignal | undefined,
  mismatchMessage: string,
  submittedSignature?: string,
): Promise<MintAccountInfo> {
  return waitForParsedState(
    // All callers reach this poll only after exact transaction verification.
    () => getReadableMint(address),
    matches,
    signal,
    mismatchMessage,
    submittedSignature,
  );
}

async function waitForTokenAccountState(
  address: string,
  matches: (tokenAccount: TokenAccountInfo) => boolean,
  signal: AbortSignal | undefined,
  mismatchMessage: string,
  submittedSignature?: string,
): Promise<TokenAccountInfo> {
  return waitForParsedState(
    // INCLUDED point reads are acceptable after the creating transaction has
    // been authoritatively verified, but the parsed content must still match.
    () => getReadableTokenAccount(address),
    matches,
    signal,
    mismatchMessage,
    submittedSignature,
  );
}

async function waitForParsedState<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  signal: AbortSignal | undefined,
  mismatchMessage: string,
  submittedSignature?: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    try {
      const value = await read();
      if (matches(value)) return value;
      lastError = new Error(mismatchMessage);
    } catch (error) {
      lastError = error;
    }
    await abortableDelay(Math.min(500 * 2 ** attempt, 4_000), signal);
  }

  if (submittedSignature) {
    throw new TransactionStatusUncertainError(submittedSignature, false);
  }
  throw new Error(
    `${mismatchMessage} ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function randomSeedHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
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
