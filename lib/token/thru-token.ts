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
  buildTransactionForSigning,
  signTransactionForSubmission,
  SubmittedTransactionUncertainError,
  verifySubmittedTransaction,
} from "@/lib/thru/transactions";
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
import type { PendingTokenSetup } from "./pending-setup";
import {
  assertOfficialTokenProgramOwnership,
  buildDestinationInitializeAccountArgs,
  deriveDestinationTokenAccount,
  ensureDestinationTokenAccount,
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

export const TOKEN_PROGRAM_ADDRESS =
  "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";

const FINALIZATION_TIMEOUT_MS = 60_000;
const REFRESH_ATTEMPTS = 7;
const TOKEN_ACCOUNT_DEFAULT_SEED = new Uint8Array(32);

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
export async function verifyAndRecoverTokenOnAlphaNet(
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

export async function createTokenOnAlphaNet(
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

  const getContext = (): TokenCreationContext => {
    if (!context) {
      throw new Error("Token creation context is unavailable.");
    }
    return context;
  };

  const workflowResult = await runTokenCreationWorkflow(
    {
      validate: async () => {
        signal?.throwIfAborted();
        const validated = validateTokenInput(input);
        await assertActiveWalletExists(account.address, signal);

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
        onPendingSetupAvailable?.({
          walletAddress: account.address,
          mintAddress: mint.address,
          tokenAccountAddress: tokenAccount.address,
          name: input.name,
          ticker: input.ticker,
          decimals: input.decimals,
          initialSupply: input.initialSupply,
        });
      },

      createMint: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
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
          onSubmitted,
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
          signal,
          "The finalized mint state did not match the requested configuration.",
        );

        return { signature };
      },

      createTokenAccount: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
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
          onSubmitted,
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
          signal,
          "The finalized token account state did not match its mint and owner.",
        );

        return { signature };
      },

      mintInitialSupply: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [
              current.mint.address,
              current.tokenAccount.address,
            ],
          },
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
          onSubmitted,
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
        signal?.throwIfAborted();
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
            signal,
            "Mint supply or authority did not match after finalization.",
          ),
          waitForTokenAccountState(
            current.tokenAccount.address,
            (tokenAccount) =>
              tokenAccount.mint === current.mint.address &&
              tokenAccount.owner === account.address &&
              tokenAccount.amount === current.validated.initialSupplyRaw &&
              !tokenAccount.isFrozen,
            signal,
            "Token account balance did not match the initial supply.",
          ),
        ]);
        current.verifiedMint = verifiedMint;
        current.verifiedTokenAccount = verifiedTokenAccount;
      },
    },
    onProgress,
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

export async function fetchTokenPortfolioOnAlphaNet(
  records: KnownTokenRecord[],
  options: { signal?: AbortSignal } = {},
): Promise<TokenPortfolioItem[]> {
  const { signal } = options;
  return Promise.all(
    records.map(async (record): Promise<TokenPortfolioItem> => {
      signal?.throwIfAborted();
      const mintResult = await settleTokenRead(() =>
        getVerifiedMint(record.mintAddress),
      );
      const tokenAccounts = await Promise.all(
        record.tokenAccountAddresses.map(
          async (address): Promise<TokenPortfolioAccount> => {
            signal?.throwIfAborted();
            const result = await settleTokenRead(() =>
              getVerifiedTokenAccount(address),
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
    getAccount(address) {
      return thru.accounts.get(address, {
        minConsensus: ConsensusStatus.FINALIZED,
      });
    },
  };

export async function discoverControlledTokensOnAlphaNet(
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

export async function resumeTokenSetupOnAlphaNet(
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
    mint = await getVerifiedMint(mintAddress);
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
    tokenAccount = await getOptionalVerifiedTokenAccount(tokenAccountAddress);
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
        );
        tokenAccountCreated = true;
      }
    }

    mint = await getVerifiedMint(mintAddress);
    tokenAccount =
      tokenAccount ?? (await getVerifiedTokenAccount(tokenAccountAddress));
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
      const rawAmount = requireValue(initialSupplyRaw, "Initial supply");
      const beforeMint = mint;
      const beforeTokenAccount = tokenAccount;
      const transaction = await buildTransactionForSigning({
        feePayer: { publicKey: account.publicKey },
        program: TOKEN_PROGRAM_ADDRESS,
        accounts: {
          readWrite: [mintAddress, tokenAccountAddress],
        },
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
            getVerifiedMint(mintAddress),
            getVerifiedTokenAccount(tokenAccountAddress),
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
      initialSupplyMinted = true;
    }

    progress("verifying-on-chain-state");
    [mint, tokenAccount] = await Promise.all([
      getVerifiedMint(mintAddress),
      getVerifiedTokenAccount(tokenAccountAddress),
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

export async function createDestinationTokenAccountOnAlphaNet(
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

    const ensured = await ensureDestinationTokenAccount(
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
              activeSignature = signature;
              progress("waiting-final-consensus", { signature });
            },
            timeoutMs,
            signal,
            {
              isRequiredConsensus: (status) =>
                status === ConsensusStatus.CLUSTER_EXECUTED,
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
            signal,
            "The created destination token account did not match its mint, owner, zero balance, or frozen state.",
          );
        },
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

export async function mintAdditionalSupplyOnAlphaNet(
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

  const result = await runTokenMutationWorkflow(
    {
      validate: async () => {
        signal?.throwIfAborted();
        await assertActiveWalletExists(account.address, signal);
        [beforeMint, beforeDestination] = await Promise.all([
          getVerifiedMint(mintAddress),
          getVerifiedTokenAccount(destinationAddress),
        ]);
        amountRaw = validateMintToPreflight({
          mintAddress,
          destinationAddress,
          activeWalletAddress: account.address,
          amount: input.amount,
          mint: beforeMint,
          destination: beforeDestination,
        });
      },
      execute: async (callbacks) => {
        signal?.throwIfAborted();
        const rawAmount = requireValue(amountRaw, "Mint amount");
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [mintAddress, destinationAddress],
          },
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
          callbacks.onSubmitted,
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
        const rawAmount = requireValue(amountRaw, "Mint amount");
        const verified = await waitForParsedState(
          async () => {
            const [nextMint, nextDestination] = await Promise.all([
              getVerifiedMint(mintAddress),
              getVerifiedTokenAccount(destinationAddress),
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
          signal,
          "Mint supply or destination balance did not reflect the additional supply.",
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

export async function transferTokensOnAlphaNet(
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

  const result = await runTokenMutationWorkflow(
    {
      validate: async () => {
        signal?.throwIfAborted();
        await assertActiveWalletExists(account.address, signal);
        [beforeSource, beforeDestination] = await Promise.all([
          getVerifiedTokenAccount(sourceAddress),
          getVerifiedTokenAccount(destinationAddress),
        ]);
        mintAddress = beforeSource.mint;
        beforeMint = await getVerifiedMint(mintAddress);
        amountRaw = validateTransferPreflight({
          mintAddress,
          sourceAddress,
          destinationAddress,
          activeWalletAddress: account.address,
          amount: input.amount,
          mint: beforeMint,
          source: beforeSource,
          destination: beforeDestination,
        });
      },
      execute: async (callbacks) => {
        signal?.throwIfAborted();
        const rawAmount = requireValue(amountRaw, "Transfer amount");
        const transaction = await buildTransactionForSigning({
          feePayer: { publicKey: account.publicKey },
          program: TOKEN_PROGRAM_ADDRESS,
          accounts: {
            readWrite: [sourceAddress, destinationAddress],
          },
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
          callbacks.onSubmitted,
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
        const rawAmount = requireValue(amountRaw, "Transfer amount");
        const verified = await waitForParsedState(
          async () => {
            const [nextMint, nextSource, nextDestination] = await Promise.all([
              getVerifiedMint(mintAddress),
              getVerifiedTokenAccount(sourceAddress),
              getVerifiedTokenAccount(destinationAddress),
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
          signal,
          "Transfer balances or mint supply did not match the submitted amount.",
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
    const wallet = await thru.accounts.get(address, {
      minConsensus: ConsensusStatus.FINALIZED,
    });
    if (wallet.meta?.flags.isDeleted) {
      throw new Error("The active wallet account is deleted on AlphaNet.");
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

async function submitAndRequireFinalizedExecution(
  transaction: Transaction,
  onSubmitted: (signature: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
  tracking: {
    isRequiredConsensus?: (status: number) => boolean;
    onFinalConsensus?: () => void;
    verifyExpectedState?: () => Promise<boolean>;
  } = {},
): Promise<string> {
  const {
    isRequiredConsensus = isFinalConsensus,
    onFinalConsensus,
    verifyExpectedState,
  } = tracking;
  let signature = transaction.getSignature()?.toThruFmt() ?? "";
  let submittedNotified = false;
  let finalized = false;
  let executionSucceeded = false;
  let finalConsensusNotified = false;
  let definitiveTrackingFailure = false;
  let latestExecution:
    | {
        vmError: number;
        userErrorCode: bigint;
        executionResult?: bigint;
        errorProgramAccIdx?: number;
      }
    | undefined;

  const verifyCompletedExecution = (): boolean => {
    if (!finalized || !latestExecution) return false;
    if (!finalConsensusNotified) {
      finalConsensusNotified = true;
      onFinalConsensus?.();
    }
    executionSucceeded = assertExecutionSucceeded(latestExecution);
    return executionSucceeded;
  };

  try {
    for await (const update of thru.transactions.sendAndTrack(
      transaction.toWire(),
      { timeoutMs, signal },
    )) {
      signal?.throwIfAborted();

      if (update.signature?.value) {
        const trackedSignature = Signature.from(
          update.signature.value,
        ).toThruFmt();
        if (signature && trackedSignature !== signature) {
          definitiveTrackingFailure = true;
          throw new Error(
            "The tracked token transaction signature does not match.",
          );
        }
        signature = trackedSignature;
        if (!submittedNotified) {
          submittedNotified = true;
          onSubmitted(signature);
        }
      }

      if (update.executionResult) {
        latestExecution = update.executionResult;
      }

      if (isRequiredConsensus(update.consensusStatus)) {
        finalized = true;
      }

      verifyCompletedExecution();
      if (signature && finalized && executionSucceeded) {
        if (!submittedNotified) {
          submittedNotified = true;
          onSubmitted(signature);
        }
        return signature;
      }
    }
  } catch (error) {
    if (signal?.aborted || definitiveTrackingFailure || !signature) {
      throw error;
    }
  }

  if (!signature) {
    throw new Error("The transaction ended without a signature.");
  }

  try {
    const verification = await verifySubmittedTransaction({
      signature,
      verifyExpectedState,
      classifyExpectedStateError: classifyTokenPostStateError,
      signal,
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
  if (!submittedNotified) {
    submittedNotified = true;
    onSubmitted(signature);
  }
  if (!finalConsensusNotified) {
    finalConsensusNotified = true;
    onFinalConsensus?.();
  }
  return signature;
}

function classifyTokenPostStateError(
  error: unknown,
): "pending" | "failure" {
  if (isAccountNotFoundError(error) || isTransactionNotFoundError(error)) {
    return "pending";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:rpc|grpc|proxy|upstream|transport|connection|disconnect|reset|refused|unavailable|socket|network|timeout|fetch)\b/i.test(
    message,
  )
    ? "pending"
    : "failure";
}

function isFinalConsensus(status: number): boolean {
  return (
    status === ConsensusStatus.FINALIZED ||
    status === ConsensusStatus.CLUSTER_EXECUTED
  );
}

function assertExecutionSucceeded(result: {
  vmError: number;
  userErrorCode: bigint;
  executionResult?: bigint;
  errorProgramAccIdx?: number;
}): boolean {
  if (
    result.vmError !== 0 ||
    result.userErrorCode !== 0n ||
    (result.executionResult !== undefined && result.executionResult !== 0n)
  ) {
    throw new Error(
      `Token transaction execution failed (vmError: ${result.vmError}, ` +
        `userErrorCode: ${result.userErrorCode.toString()}, ` +
        `executionResult: ${result.executionResult?.toString() ?? "missing"}, ` +
        `errorProgramAccIdx: ${result.errorProgramAccIdx ?? "unknown"}).`,
    );
  }
  return result.executionResult === 0n;
}

async function getVerifiedMint(address: string): Promise<MintAccountInfo> {
  const account = await getTokenProgramAccount(address);
  return parseMintAccountData(account);
}

async function getVerifiedTokenAccount(
  address: string,
): Promise<TokenAccountInfo> {
  const account = await getTokenProgramAccount(address);
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

async function getTokenProgramAccount(address: string): Promise<Account> {
  const account = await thru.accounts.get(address, {
    minConsensus: ConsensusStatus.FINALIZED,
  });
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
): Promise<MintAccountInfo> {
  return waitForParsedState(
    () => getVerifiedMint(address),
    matches,
    signal,
    mismatchMessage,
  );
}

async function waitForTokenAccountState(
  address: string,
  matches: (tokenAccount: TokenAccountInfo) => boolean,
  signal: AbortSignal | undefined,
  mismatchMessage: string,
): Promise<TokenAccountInfo> {
  return waitForParsedState(
    () => getVerifiedTokenAccount(address),
    matches,
    signal,
    mismatchMessage,
  );
}

async function waitForParsedState<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  signal: AbortSignal | undefined,
  mismatchMessage: string,
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
