import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConsensusStatus, Pubkey, Signature, type Account, type BuildTransactionOptions, type Transaction } from "@thru/sdk";
import { TokenAccount, TokenMintAccount } from "@thru/programs/token";
import {
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_TRANSACTION_RESOURCES,
  TokenTransactionExecutionError,
  createTokenOnBetanet,
  observeMintState,
  reconcilePendingOperation,
  reconcilePreviousTokenCreationBeforeNew,
  submitAndRequireFinalizedExecution,
  tokenCreationHeader,
} from "../lib/token/thru-token";
import { thru } from "../lib/wallet/thru-wallet";
import {
  canonicalTokenOperationKey,
  loadPendingTokenOperations,
  persistPendingTokenOperation,
  PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
  PENDING_TOKEN_OPERATION_STORAGE_KEY,
  type PendingTokenOperationRecord,
} from "../lib/token/pending-operation";
import {
  savePendingSetups,
  type PendingTokenSetup,
} from "../lib/token/pending-setup";
import { TransactionStatusUncertainError } from "../lib/token/transaction-status";

const address = (byte: number) =>
  Pubkey.from(new Uint8Array(32).fill(byte)).toThruFmt();
const signature = (byte: number) =>
  Signature.from(new Uint8Array(64).fill(byte)).toThruFmt();
const execution = (vmError = 0, userErrorCode = 0n) => ({
  vmError,
  userErrorCode,
  executionResult: 0n,
});
const status = (byte: number, consensusStatus: ConsensusStatus, vmError = 0, userErrorCode = 0n) => ({
  signature: new Uint8Array(64).fill(byte),
  statusCode: consensusStatus,
  executionResult: execution(vmError, userErrorCode),
});
const transaction = (byte: number): Transaction => ({
  getSignature: () => Signature.from(new Uint8Array(64).fill(byte)),
  toWire: () => new Uint8Array([1, 2, byte]),
}) as Transaction;

test("Token Program headers use the proven Betanet budget and creation-proof slot", () => {
  assert.deepEqual(TOKEN_TRANSACTION_RESOURCES, {
    fee: 0n,
    expiryAfter: 100,
    computeUnits: 300_000,
    stateUnits: 0,
    memoryUnits: 10_000,
  });
  assert.deepEqual(tokenCreationHeader(123n), {
    ...TOKEN_TRANSACTION_RESOURCES,
    startSlot: 123n,
    stateUnits: 1,
  });
  assert.throws(() => tokenCreationHeader(0n), /proof slot is unavailable/);
});

function testStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => { entries.clear(); },
    key: (index) => Array.from(entries.keys())[index] ?? null,
    get length() { return entries.size; },
  };
}

function useTestStorage(t: TestContext): Storage {
  const storage = testStorage();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return storage;
}

function includedMint(mintAddress: string, walletAddress: string, supply = 0n): Account {
  const ticker = new Uint8Array(9);
  ticker.set([3, 84, 83, 84]);
  const data = TokenMintAccount.builder()
    .set_decimals(6)
    .set_supply(supply)
    .set_creator(Pubkey.from(walletAddress).toBytes())
    .set_mint_authority(Pubkey.from(walletAddress).toBytes())
    .set_freeze_authority(new Uint8Array(32))
    .set_has_freeze_authority(0)
    .set_ticker(ticker)
    .build();
  return {
    address: Pubkey.from(mintAddress),
    meta: { owner: Pubkey.from(TOKEN_PROGRAM_ADDRESS), dataSize: data.length },
    data: { data },
    consensusStatus: ConsensusStatus.INCLUDED,
  } as Account;
}

function includedTokenAccount(
  tokenAddress: string,
  mintAddress: string,
  walletAddress: string,
  amount: bigint,
): Account {
  const data = TokenAccount.builder()
    .set_mint(Pubkey.from(mintAddress).toBytes())
    .set_owner(Pubkey.from(walletAddress).toBytes())
    .set_amount(amount)
    .set_is_frozen(0)
    .build();
  return {
    address: Pubkey.from(tokenAddress),
    meta: { owner: Pubkey.from(TOKEN_PROGRAM_ADDRESS), dataSize: data.length },
    data: { data },
    consensusStatus: ConsensusStatus.INCLUDED,
  } as Account;
}

function pendingMintRecord(walletAddress: string, mintAddress: string, sig: string): PendingTokenOperationRecord {
  const now = Date.now();
  return {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key: canonicalTokenOperationKey({ operationType: "create-mint", walletAddress, mintAddress }),
    operationType: "create-mint",
    signature: sig,
    walletAddress,
    mintAddress,
    expectedPostState: {
      mintSupply: "0",
      mintDecimals: 6,
      mintCreator: walletAddress,
      mintAuthority: walletAddress,
      mintTicker: "TST",
    },
    createdAt: now,
    lastCheckedAt: now,
    status: "submitted",
  };
}

test("token submission sends once, polls getStatus, and accepts CLUSTER_EXECUTED", async (t) => {
  let sends = 0;
  let polls = 0;
  let submitted = "";
  let finalCallbacks = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    return signature(11);
  });
  t.mock.method(thru.transactions, "getStatus", async () => {
    polls += 1;
    return status(11, polls === 1 ? ConsensusStatus.INCLUDED : ConsensusStatus.CLUSTER_EXECUTED);
  });
  const result = await submitAndRequireFinalizedExecution(
    transaction(11),
    (value) => { submitted = value; },
    3_000,
    undefined,
    { onFinalConsensus: () => { finalCallbacks += 1; } },
  );
  assert.equal(result, signature(11));
  assert.equal(submitted, result);
  assert.equal(sends, 1);
  assert.equal(polls, 2);
  assert.equal(finalCallbacks, 1);
});

test("token submission rejects signature mismatch without rebroadcast", async (t) => {
  let sends = 0;
  let polls = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    return signature(13);
  });
  t.mock.method(thru.transactions, "getStatus", async () => {
    polls += 1;
    return status(12, ConsensusStatus.CLUSTER_EXECUTED);
  });
  await assert.rejects(
    () => submitAndRequireFinalizedExecution(transaction(12), () => undefined, 100),
    (error: unknown) => error instanceof TransactionStatusUncertainError &&
      error.signature === signature(12),
  );
  assert.equal(sends, 1);
  assert.equal(polls, 0);
});

test("a pending-operation journal failure prevents token submission", async (t) => {
  let sends = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    return signature(16);
  });
  await assert.rejects(
    () => submitAndRequireFinalizedExecution(
      transaction(16),
      () => { throw new Error("journal write failed"); },
      100,
    ),
    /journal write failed/,
  );
  assert.equal(sends, 0);
});

test("token execution vm/user error is definitive and typed", async (t) => {
  t.mock.method(thru.transactions, "send", async () => signature(14));
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(14, ConsensusStatus.CLUSTER_EXECUTED, 7, 29n));
  await assert.rejects(
    () => submitAndRequireFinalizedExecution(transaction(14), () => undefined, 100),
    (error: unknown) => error instanceof TokenTransactionExecutionError &&
      error.vmError === 7 && error.userErrorCode === 29n,
  );
});

test("token status timeout remains uncertain with one send", async (t) => {
  let sends = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    return signature(15);
  });
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw new Error("read-only status unavailable");
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("transaction not found");
  });
  await assert.rejects(
    () => submitAndRequireFinalizedExecution(
      transaction(15),
      () => undefined,
      1,
      undefined,
      { verifyExpectedState: async () => false },
    ),
    TransactionStatusUncertainError,
  );
  assert.equal(sends, 1);
});

test("missing transaction status can reconcile a finalized exact mint without rebroadcast", async (t) => {
  const walletAddress = address(18);
  const mintAddress = address(19);
  let sends = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    return signature(18);
  });
  t.mock.method(thru.transactions, "getStatus", async () => {
    throw new Error("[not_found] transaction not found");
  });
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("[not_found] transaction not found");
  });
  t.mock.method(thru.accounts, "get", async () => Object.assign(
    includedMint(mintAddress, walletAddress),
    { consensusStatus: ConsensusStatus.FINALIZED },
  ));

  const result = await submitAndRequireFinalizedExecution(
    transaction(18),
    () => undefined,
    1,
    undefined,
    {
      verifyExpectedState: () => observeMintState(mintAddress, (mint) =>
        mint.creator === walletAddress &&
        mint.mintAuthority === walletAddress &&
        mint.ticker === "TST" &&
        mint.decimals === 6 &&
        mint.supply === 0n),
    },
  );
  assert.equal(result, signature(18));
  assert.equal(sends, 1);
});

test("exact CLUSTER_EXECUTED transaction can reconcile an INCLUDED mint without sending", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(21);
  const mintAddress = address(22);
  const record = pendingMintRecord(walletAddress, mintAddress, signature(23));
  persistPendingTokenOperation(record);
  let sends = 0;
  let reads = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    throw new Error("must not submit");
  });
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(23, ConsensusStatus.CLUSTER_EXECUTED));
  t.mock.method(thru.accounts, "get", async () => {
    reads += 1;
    return includedMint(mintAddress, walletAddress);
  });
  const reconciled = await reconcilePendingOperation({
    base: {
      key: record.key,
      operationType: record.operationType,
      walletAddress,
      mintAddress,
      expectedPostState: record.expectedPostState,
    },
    timeoutMs: 10,
    verifyExpectedState: async () => { throw new Error("finalized-only fallback must not run"); },
    buildResult: async (sig) => sig,
  });
  assert.deepEqual(reconciled, { outcome: "success", result: record.signature });
  assert.equal(reads, 1);
  assert.equal(sends, 0);
  assert.deepEqual(loadPendingTokenOperations(storage), []);
});

test("pending token-account creation reconciles exact INCLUDED owner and mint", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(24);
  const mintAddress = address(25);
  const tokenAddress = address(26);
  const now = Date.now();
  const record: PendingTokenOperationRecord = {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key: canonicalTokenOperationKey({
      operationType: "create-token-account",
      walletAddress,
      mintAddress,
      destinationTokenAccount: tokenAddress,
      recipientAddress: walletAddress,
    }),
    operationType: "create-token-account",
    signature: signature(27),
    walletAddress,
    mintAddress,
    destinationTokenAccount: tokenAddress,
    recipientAddress: walletAddress,
    expectedPostState: { destinationBalance: "0", destinationOwner: walletAddress, destinationFrozen: false },
    createdAt: now,
    lastCheckedAt: now,
    status: "submitted",
  };
  persistPendingTokenOperation(record);
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(27, ConsensusStatus.CLUSTER_EXECUTED));
  t.mock.method(thru.accounts, "get", async () =>
    includedTokenAccount(tokenAddress, mintAddress, walletAddress, 0n));
  const result = await reconcilePendingOperation({
    base: {
      key: record.key,
      operationType: record.operationType,
      walletAddress,
      mintAddress,
      expectedPostState: record.expectedPostState,
    },
    timeoutMs: 10,
    verifyExpectedState: async () => false,
    buildResult: async (sig) => sig,
  });
  assert.deepEqual(result, { outcome: "success", result: record.signature });
  assert.deepEqual(loadPendingTokenOperations(storage), []);
});

test("pending initial supply reconciles exact INCLUDED mint and balance", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(28);
  const mintAddress = address(29);
  const tokenAddress = address(30);
  const now = Date.now();
  const record: PendingTokenOperationRecord = {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key: canonicalTokenOperationKey({
      operationType: "initial-supply",
      walletAddress,
      mintAddress,
      destinationTokenAccount: tokenAddress,
      recipientAddress: walletAddress,
      amountRaw: 1000n,
    }),
    operationType: "initial-supply",
    signature: signature(31),
    walletAddress,
    mintAddress,
    destinationTokenAccount: tokenAddress,
    recipientAddress: walletAddress,
    amountRaw: "1000",
    expectedPostState: {
      mintSupply: "1000",
      destinationBalance: "1000",
      destinationOwner: walletAddress,
      destinationFrozen: false,
    },
    createdAt: now,
    lastCheckedAt: now,
    status: "submitted",
  };
  persistPendingTokenOperation(record);
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(31, ConsensusStatus.CLUSTER_EXECUTED));
  t.mock.method(thru.accounts, "get", async (value: string) =>
    value === mintAddress
      ? includedMint(mintAddress, walletAddress, 1000n)
      : includedTokenAccount(tokenAddress, mintAddress, walletAddress, 1000n));
  const result = await reconcilePendingOperation({
    base: {
      key: record.key,
      operationType: record.operationType,
      walletAddress,
      mintAddress,
      expectedPostState: record.expectedPostState,
    },
    timeoutMs: 10,
    verifyExpectedState: async () => false,
    buildResult: async (sig) => sig,
  });
  assert.deepEqual(result, { outcome: "success", result: record.signature });
  assert.deepEqual(loadPendingTokenOperations(storage), []);
});

test("INCLUDED transaction status alone cannot reconcile an INCLUDED mint", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(31);
  const mintAddress = address(32);
  const record = pendingMintRecord(walletAddress, mintAddress, signature(33));
  persistPendingTokenOperation(record);
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(33, ConsensusStatus.INCLUDED));
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("transaction not found");
  });
  t.mock.method(thru.accounts, "get", async () => includedMint(mintAddress, walletAddress));
  await assert.rejects(
    () => reconcilePendingOperation({
      base: {
        key: record.key,
        operationType: record.operationType,
        walletAddress,
        mintAddress,
        expectedPostState: record.expectedPostState,
      },
      timeoutMs: 1,
      verifyExpectedState: async () => false,
      buildResult: async () => { throw new Error("must not accept provisional state"); },
    }),
    TransactionStatusUncertainError,
  );
  assert.equal(loadPendingTokenOperations(storage).length, 1);
});

test("matching transaction status cannot accept a different point-account address", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(35);
  const mintAddress = address(36);
  const record = pendingMintRecord(walletAddress, mintAddress, signature(37));
  persistPendingTokenOperation(record);
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(37, ConsensusStatus.CLUSTER_EXECUTED));
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("transaction not found");
  });
  t.mock.method(thru.accounts, "get", async () => includedMint(address(38), walletAddress));
  await assert.rejects(
    () => reconcilePendingOperation({
      base: {
        key: record.key,
        operationType: record.operationType,
        walletAddress,
        mintAddress,
        expectedPostState: record.expectedPostState,
      },
      timeoutMs: 1,
      verifyExpectedState: async () => false,
      buildResult: async () => { throw new Error("must not accept mismatched address"); },
    }),
    TransactionStatusUncertainError,
  );
  assert.equal(loadPendingTokenOperations(storage).length, 1);
});

test("a submitted pending setup blocks a new token seed until resume", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(41);
  const mintAddress = address(42);
  const setup: PendingTokenSetup = {
    walletAddress,
    mintAddress,
    tokenAccountAddress: address(43),
    name: "Test Token",
    ticker: "TST",
    decimals: 6,
    initialSupply: "10",
    mintSignature: signature(44),
    savedAt: Date.now(),
  };
  savePendingSetups(storage, [setup]);
  let sends = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    throw new Error("must not send");
  });
  await assert.rejects(
    () => reconcilePreviousTokenCreationBeforeNew(walletAddress, 10),
    /Resume and verify that setup/,
  );
  assert.equal(sends, 0);
  assert.equal(storage.getItem(PENDING_TOKEN_OPERATION_STORAGE_KEY), null);
});

test("pre-create reconciliation retains a successful old mint journal for resume", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(45);
  const mintAddress = address(46);
  const record = pendingMintRecord(walletAddress, mintAddress, signature(47));
  persistPendingTokenOperation(record);
  let sends = 0;
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    throw new Error("must not rebroadcast");
  });
  t.mock.method(thru.transactions, "getStatus", async () =>
    status(47, ConsensusStatus.CLUSTER_EXECUTED));
  t.mock.method(thru.accounts, "get", async () => includedMint(mintAddress, walletAddress));
  await assert.rejects(
    () => reconcilePreviousTokenCreationBeforeNew(walletAddress, 10),
    /Resume and verify that setup/,
  );
  assert.equal(sends, 0);
  assert.equal(loadPendingTokenOperations(storage).length, 1);
  assert.equal(loadPendingTokenOperations(storage)[0].signature, record.signature);
});

test("create-token entry reconciles pending metadata before proof or submission", async (t) => {
  const storage = useTestStorage(t);
  const walletAddress = address(51);
  savePendingSetups(storage, [{
    walletAddress,
    mintAddress: address(52),
    tokenAccountAddress: address(53),
    name: "Previous Token",
    ticker: "PREV",
    decimals: 6,
    initialSupply: "10",
    mintSignature: signature(54),
    savedAt: Date.now(),
  }]);
  let sends = 0;
  let proofs = 0;
  t.mock.method(thru.accounts, "get", async () => ({
    address: Pubkey.from(walletAddress),
    consensusStatus: ConsensusStatus.INCLUDED,
    meta: { flags: { isDeleted: false } },
  }) as Account);
  t.mock.method(thru.proofs, "generate", async () => {
    proofs += 1;
    throw new Error("must not generate a proof");
  });
  t.mock.method(thru.transactions, "send", async () => {
    sends += 1;
    throw new Error("must not submit");
  });
  await assert.rejects(
    () => createTokenOnBetanet(
      {
        address: walletAddress,
        publicKey: Pubkey.from(walletAddress).toBytes(),
        privateKey: new Uint8Array(32),
      },
      { name: "New Token", ticker: "NEW", decimals: 6, initialSupply: "10" },
      { onProgress: () => undefined },
    ),
    /Resume and verify that setup/,
  );
  assert.equal(proofs, 0);
  assert.equal(sends, 0);
});

test("a verified mint continues through account creation and initial supply with exact proof slots", async (t) => {
  useTestStorage(t);
  const walletAddress = address(61);
  let mintAddress = "";
  let tokenAddress = "";
  let mintLive = false;
  let tokenLive = false;
  let supplyLive = false;
  let proofCount = 0;
  let sends = 0;
  const headers: Array<Record<string, unknown>> = [];
  const stages: string[] = [];
  const bytes = [71, 72, 73];

  t.mock.method(thru.accounts, "get", async (requested: string) => {
    if (requested === walletAddress) {
      return {
        address: Pubkey.from(walletAddress),
        consensusStatus: ConsensusStatus.INCLUDED,
        meta: { flags: { isDeleted: false } },
      } as Account;
    }
    if (requested === mintAddress && mintLive) {
      return includedMint(mintAddress, walletAddress, supplyLive ? 1_000_000n : 0n);
    }
    if (requested === tokenAddress && tokenLive) {
      return includedTokenAccount(
        tokenAddress,
        mintAddress,
        walletAddress,
        supplyLive ? 1_000_000n : 0n,
      );
    }
    throw new Error("[not_found] account not found");
  });
  t.mock.method(thru.proofs, "generate", async () => ({
    slot: 120n + BigInt(proofCount++),
    proof: new Uint8Array([9]),
  }));
  t.mock.method(thru.transactions, "build", async (options: BuildTransactionOptions) => {
    const byte = bytes[headers.length];
    headers.push({ ...options.header });
    return Object.assign(transaction(byte), {
      chainId: 2,
      startSlot: options.header?.startSlot ?? 122n,
      sign: async () => undefined,
    });
  });
  t.mock.method(thru.transactions, "send", async (wire: Uint8Array) => {
    sends += 1;
    const byte = wire[2];
    if (byte === bytes[0]) mintLive = true;
    else if (byte === bytes[1]) tokenLive = true;
    else if (byte === bytes[2]) supplyLive = true;
    else throw new Error("Unexpected token transaction");
    return signature(byte);
  });
  t.mock.method(thru.transactions, "getStatus", async (value: string) => {
    const byte = bytes.find((candidate) => signature(candidate) === value);
    if (byte === undefined) throw new Error("Unexpected signature");
    return status(byte, ConsensusStatus.CLUSTER_EXECUTED);
  });

  const result = await createTokenOnBetanet(
    {
      address: walletAddress,
      publicKey: Pubkey.from(walletAddress).toBytes(),
      privateKey: new Uint8Array(32),
    },
    { name: "Betanet Smoke", ticker: "TST", decimals: 6, initialSupply: "1" },
    {
      onProgress: (progress) => stages.push(progress.stage),
      onPendingSetupAvailable: (setup) => {
        mintAddress = setup.mintAddress;
        tokenAddress = setup.tokenAccountAddress;
      },
    },
  );

  assert.equal(sends, 3);
  assert.equal(proofCount, 2);
  assert.deepEqual(headers[0], tokenCreationHeader(120n));
  assert.deepEqual(headers[1], tokenCreationHeader(121n));
  assert.deepEqual(headers[2], TOKEN_TRANSACTION_RESOURCES);
  assert.equal(result.mint.supply, 1_000_000n);
  assert.equal(result.tokenAccount.amount, 1_000_000n);
  assert.deepEqual(
    [result.mintSignature, result.tokenAccountSignature, result.initialSupplySignature],
    bytes.map(signature),
  );
  assert.deepEqual(stages.filter((stage) =>
    stage === "creating-mint" ||
    stage === "creating-token-account" ||
    stage === "minting-initial-supply" ||
    stage === "completed"), [
    "creating-mint",
    "creating-token-account",
    "minting-initial-supply",
    "minting-initial-supply",
    "completed",
  ]);
});
