import assert from "node:assert/strict";
import test from "node:test";
import { Pubkey, Signature } from "@thru/sdk";
import {
  PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
  PENDING_TOKEN_OPERATION_STORAGE_KEY,
  LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
  PendingOperationJournalError,
  canonicalTokenOperationKey,
  findPendingTokenOperation,
  loadPendingTokenOperations,
  removePendingTokenOperation,
  reconcilePendingTokenOperationJournal,
  savePendingTokenOperations,
  upsertPendingTokenOperation,
  type PendingTokenOperationRecord,
} from "../lib/token/pending-operation";
import { decimalAmountToRaw } from "../lib/token/validation";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const address = (seed: number) =>
  Pubkey.from(new Uint8Array(32).fill(seed)).toThruFmt();
const signature = Signature.from(new Uint8Array(64).fill(91)).toThruFmt();
const WALLET = address(1);
const MINT = address(2);
const SOURCE = address(3);
const DESTINATION = address(4);
const RECIPIENT = address(5);

function operation(
  overrides: Partial<PendingTokenOperationRecord> = {},
): PendingTokenOperationRecord {
  const createdAt = 1_700_000_000_000;
  const amountRaw = 100n;
  const key = canonicalTokenOperationKey({
    operationType: "transfer",
    walletAddress: WALLET,
    mintAddress: MINT,
    sourceTokenAccount: SOURCE,
    destinationTokenAccount: DESTINATION,
    recipientAddress: RECIPIENT,
    amountRaw,
  });
  return {
    schemaVersion: PENDING_TOKEN_OPERATION_SCHEMA_VERSION,
    key,
    operationType: "transfer",
    signature,
    walletAddress: WALLET,
    mintAddress: MINT,
    sourceTokenAccount: SOURCE,
    destinationTokenAccount: DESTINATION,
    recipientAddress: RECIPIENT,
    amountRaw: amountRaw.toString(10),
    expectedPreState: {
      mintSupply: "1000",
      sourceBalance: "500",
      destinationBalance: "10",
    },
    expectedPostState: {
      mintSupply: "1000",
      sourceBalance: "400",
      sourceOwner: WALLET,
      destinationBalance: "110",
      destinationOwner: RECIPIENT,
      destinationFrozen: false,
    },
    createdAt,
    lastCheckedAt: createdAt,
    status: "submitted",
    ...overrides,
  };
}

test("equivalent display amounts produce the same raw canonical operation key", () => {
  const inputs = ["1", "1.0", "1.00"];
  const keys = inputs.map((amount) =>
    canonicalTokenOperationKey({
      operationType: "transfer",
      walletAddress: WALLET,
      mintAddress: MINT,
      sourceTokenAccount: SOURCE,
      destinationTokenAccount: DESTINATION,
      recipientAddress: RECIPIENT,
      amountRaw: decimalAmountToRaw(amount, 6),
    }),
  );
  assert.equal(new Set(keys).size, 1);
});

test("different raw amounts and recipients produce separate operation keys", () => {
  const base = {
    operationType: "transfer" as const,
    walletAddress: WALLET,
    mintAddress: MINT,
    sourceTokenAccount: SOURCE,
    destinationTokenAccount: DESTINATION,
    recipientAddress: RECIPIENT,
  };
  const first = canonicalTokenOperationKey({ ...base, amountRaw: 1n });
  const amountChanged = canonicalTokenOperationKey({ ...base, amountRaw: 2n });
  const recipientChanged = canonicalTokenOperationKey({
    ...base,
    recipientAddress: address(6),
    amountRaw: 1n,
  });
  assert.notEqual(first, amountChanged);
  assert.notEqual(first, recipientChanged);
});

test("public journal survives a storage reload and remains wallet-scoped", () => {
  const storage = new MemoryStorage();
  const record = operation();
  savePendingTokenOperations(storage, [record], record.createdAt + 1);

  const reloaded = loadPendingTokenOperations(storage, record.createdAt + 2);
  assert.equal(reloaded.length, 1);
  assert.equal(
    findPendingTokenOperation(reloaded, record.key, WALLET)?.signature,
    signature,
  );
  assert.equal(
    findPendingTokenOperation(reloaded, record.key, address(9)),
    undefined,
  );
});

test("legacy AlphaNet pending operations are not reconciled on Betanet", async () => {
  const storage = new MemoryStorage();
  const record = operation();
  storage.values.set(
    LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
    JSON.stringify([record]),
  );
  let verificationCalls = 0;

  assert.deepEqual(loadPendingTokenOperations(storage, record.createdAt + 1), []);
  const result = await reconcilePendingTokenOperationJournal({
    key: record.key,
    walletAddress: WALLET,
    storage,
    now: () => record.createdAt + 2,
    verify: async () => {
      verificationCalls += 1;
      return "success";
    },
  });

  assert.deepEqual(result, { outcome: "none" });
  assert.equal(verificationCalls, 0);
  assert.equal(
    storage.values.has(LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY),
    true,
  );
});

test("upsert preserves one public signature and finalized cleanup removes it", () => {
  const record = operation();
  const uncertain = { ...record, status: "uncertain" as const };
  const upserted = upsertPendingTokenOperation([record], uncertain);
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].signature, signature);
  assert.deepEqual(removePendingTokenOperation(upserted, record.key), []);
});

test("expired entries are pruned and corrupt live journals fail closed", () => {
  const storage = new MemoryStorage();
  const record = operation();
  savePendingTokenOperations(storage, [record], record.createdAt);
  const afterEightDays = record.createdAt + 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(loadPendingTokenOperations(storage, afterEightDays), []);

  storage.values.set(PENDING_TOKEN_OPERATION_STORAGE_KEY, "{not-json");
  assert.throws(
    () => loadPendingTokenOperations(storage, record.createdAt),
    PendingOperationJournalError,
  );
});

test("unavailable or quota-limited storage fails closed", () => {
  const denied = {
    getItem(): string | null {
      throw new DOMException("denied", "SecurityError");
    },
  };
  assert.throws(
    () => loadPendingTokenOperations(denied),
    PendingOperationJournalError,
  );

  const quota = {
    setItem(): void {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
  assert.throws(
    () => savePendingTokenOperations(quota, [operation()], 1_700_000_000_001),
    PendingOperationJournalError,
  );
});

test("serialized journal contains only approved public operation metadata", () => {
  const storage = new MemoryStorage();
  const record = operation();
  savePendingTokenOperations(storage, [record], record.createdAt + 1);
  const serialized = storage.values.get(PENDING_TOKEN_OPERATION_STORAGE_KEY)!;

  assert.match(serialized, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(
    serialized,
    /privateKey|secretKey|mnemonic|password|signedTransaction|transactionBytes|backup|aesKey|sessionToken/i,
  );
});

test("finalized success reconciles after reload through read-only evidence and clears the journal", async () => {
  const storage = new MemoryStorage();
  const record = operation();
  savePendingTokenOperations(storage, [record], record.createdAt + 1);
  let readOnlyChecks = 0;

  const result = await reconcilePendingTokenOperationJournal({
    key: record.key,
    walletAddress: WALLET,
    storage,
    now: () => record.createdAt + 2,
    verify: async (reloaded) => {
      readOnlyChecks += 1;
      assert.equal(reloaded.signature, signature);
      return "success";
    },
  });

  assert.equal(result.outcome, "success");
  assert.equal(readOnlyChecks, 1);
  assert.deepEqual(loadPendingTokenOperations(storage, record.createdAt + 3), []);
});

test("definitive failure clears the pending entry and opens controlled retry", async () => {
  const storage = new MemoryStorage();
  const record = operation();
  savePendingTokenOperations(storage, [record], record.createdAt + 1);
  const result = await reconcilePendingTokenOperationJournal({
    key: record.key,
    walletAddress: WALLET,
    storage,
    now: () => record.createdAt + 2,
    verify: async () => "failure",
  });
  assert.equal(result.outcome, "failure");
  assert.equal(
    findPendingTokenOperation(
      loadPendingTokenOperations(storage, record.createdAt + 3),
      record.key,
      WALLET,
    ),
    undefined,
  );
});

test("unresolved and RPC-failed reconciliation preserve the original signature", async () => {
  for (const verify of [
    async () => "uncertain" as const,
    async () => {
      throw new Error("temporary RPC outage");
    },
  ]) {
    const storage = new MemoryStorage();
    const record = operation();
    savePendingTokenOperations(storage, [record], record.createdAt + 1);
    const result = await reconcilePendingTokenOperationJournal({
      key: record.key,
      walletAddress: WALLET,
      storage,
      now: () => record.createdAt + 2,
      verify,
    });
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.outcome === "uncertain" && result.record.signature, signature);
    const reloaded = loadPendingTokenOperations(storage, record.createdAt + 3);
    assert.equal(reloaded[0].signature, signature);
    assert.equal(reloaded[0].status, "uncertain");
  }
});
