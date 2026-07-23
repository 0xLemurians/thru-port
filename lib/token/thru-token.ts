import {
  ConsensusStatus,
  Pubkey,
  Signature,
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
  runTokenCreationWorkflow,
  runTokenMutationWorkflow,
  type TokenCreationProgress,
  type TokenMutationProgress,
} from "./workflow";
import {
  validateMintToPreflight,
  validateTransferPreflight,
  verifyMintToDeltas,
  verifyTransferDeltas,
} from "./operations";
import type { KnownTokenRecord } from "./portfolio";
import {
  validateTokenInput,
  type ValidatedTokenInput,
} from "./validation";

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
  mint?: MintAccountInfo;
  error?: string;
  tokenAccounts: TokenPortfolioAccount[];
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

interface TokenCreationContext {
  validated: ValidatedTokenInput;
  mint: ReturnType<typeof deriveMintAddress>;
  tokenAccount: ReturnType<typeof deriveTokenAccountAddress>;
  tokenAccountSeed: Uint8Array;
  mintSeedHex: string;
  verifiedMint?: MintAccountInfo;
  verifiedTokenAccount?: TokenAccountInfo;
}

export async function createTokenOnAlphaNet(
  account: ThruAccount,
  input: CreateTokenInput,
  options: CreateTokenOptions,
): Promise<CreateTokenResult> {
  const { signal, timeoutMs = FINALIZATION_TIMEOUT_MS, onProgress } = options;
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
      },

      createMint: async (onSubmitted) => {
        signal?.throwIfAborted();
        const current = getContext();
        const stateProof = await thru.proofs.generate({
          address: current.mint.address,
          proofType: StateProofType.CREATING,
        });
        signal?.throwIfAborted();

        const transaction = await thru.transactions.build({
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
        });

        await transaction.sign(account.privateKey);
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          onSubmitted,
          timeoutMs,
          signal,
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

        const transaction = await thru.transactions.build({
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
        });

        await transaction.sign(account.privateKey);
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          onSubmitted,
          timeoutMs,
          signal,
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
        const transaction = await thru.transactions.build({
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
        });

        await transaction.sign(account.privateKey);
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          onSubmitted,
          timeoutMs,
          signal,
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
        ...(mintResult.value
          ? { mint: mintResult.value }
          : { error: mintResult.error }),
        tokenAccounts,
      };
    }),
  );
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
        const transaction = await thru.transactions.build({
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
        });
        await transaction.sign(account.privateKey);
        callbacks.onAwaitingFinalConsensus();
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          callbacks.onSubmitted,
          timeoutMs,
          signal,
          callbacks.onFinalConsensus,
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
        const transaction = await thru.transactions.build({
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
        });
        await transaction.sign(account.privateKey);
        callbacks.onAwaitingFinalConsensus();
        const signature = await submitAndRequireFinalizedExecution(
          transaction,
          callbacks.onSubmitted,
          timeoutMs,
          signal,
          callbacks.onFinalConsensus,
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
  onFinalConsensus?: () => void,
): Promise<string> {
  let signature = "";
  let submittedNotified = false;
  let finalized = false;
  let executionSucceeded = false;
  let finalConsensusNotified = false;
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

  for await (const update of thru.transactions.sendAndTrack(
    transaction.toWire(),
    { timeoutMs, signal },
  )) {
    signal?.throwIfAborted();

    if (update.signature?.value) {
      signature = Signature.from(update.signature.value).toThruFmt();
      if (!submittedNotified) {
        submittedNotified = true;
        onSubmitted(signature);
      }
    }

    if (update.executionResult) {
      latestExecution = update.executionResult;
    }

    if (isFinalConsensus(update.consensusStatus)) {
      finalized = true;
    }

    verifyCompletedExecution();
    if (signature && finalized && executionSucceeded) {
      return signature;
    }
  }

  if (!signature) {
    throw new Error("The transaction ended without a signature.");
  }

  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    const status = await thru.transactions.getStatus(signature);
    if (status.executionResult) {
      latestExecution = status.executionResult;
    }
    if (status.statusCode !== undefined && isFinalConsensus(status.statusCode)) {
      finalized = true;
    }
    verifyCompletedExecution();
    if (finalized && executionSucceeded) {
      return signature;
    }
    await abortableDelay(Math.min(500 * 2 ** attempt, 4_000), signal);
  }

  if (!finalized) {
    throw new Error(
      "The transaction signature was received, but final consensus was not confirmed.",
    );
  }
  throw new Error(
    "The transaction finalized, but a successful execution result was not confirmed.",
  );
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

async function getTokenProgramAccount(address: string): Promise<Account> {
  const account = await thru.accounts.get(address, {
    minConsensus: ConsensusStatus.FINALIZED,
  });
  const owner = account.meta?.owner?.toThruFmt();
  if (owner !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error(
      `On-chain account ${address} is not owned by the official Token Program.`,
    );
  }
  return account;
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
