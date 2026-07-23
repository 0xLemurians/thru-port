import {
  ConsensusStatus,
  Signature,
  type Account,
  type Transaction,
} from "@thru/sdk";
import { StateProofType } from "@thru/sdk/proto";
import {
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
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
  type TokenCreationProgress,
} from "./workflow";
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
): Promise<string> {
  let signature = "";
  let submittedNotified = false;
  let finalized = false;
  let executionSucceeded = false;

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
      assertExecutionSucceeded(update.executionResult);
      executionSucceeded = true;
    }

    if (isFinalConsensus(update.consensusStatus)) {
      finalized = true;
    }

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
      assertExecutionSucceeded(status.executionResult);
      executionSucceeded = true;
    }
    if (status.statusCode !== undefined && isFinalConsensus(status.statusCode)) {
      finalized = true;
    }
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
}): void {
  if (result.vmError !== 0 || result.userErrorCode !== 0n) {
    throw new Error(
      `Token transaction execution failed (vmError: ${result.vmError}, userErrorCode: ${result.userErrorCode.toString()}).`,
    );
  }
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
