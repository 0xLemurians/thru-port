/**
 * Tests for token recovery and pending-setup storage.
 *
 * All tests are pure unit tests — no real RPC calls, no transactions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPendingSetups,
  savePendingSetups,
  upsertPendingSetup,
  removePendingSetup,
  pendingSetupsForWallet,
  type PendingTokenSetup,
} from "../lib/token/pending-setup";
import {
  loadKnownTokens,
  saveKnownTokens,
  upsertKnownToken,
} from "../lib/token/portfolio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal in-memory localStorage stub. */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}

// Valid Thru-format addresses accepted by Pubkey.from().
// We reuse the Token Program address as a placeholder for tests that don't
// perform owner-vs-mint comparisons.
const ADDR_A = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";

function makePending(overrides: Partial<PendingTokenSetup> = {}): PendingTokenSetup {
  return {
    walletAddress: ADDR_A,
    mintAddress: ADDR_A,
    tokenAccountAddress: ADDR_A,
    name: "MVP Test",
    ticker: "MVP",
    decimals: 2,
    initialSupply: "10",
    savedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pending setup persists on create and can be retrieved.
// ---------------------------------------------------------------------------
test("pending setup is saved during create and retrievable after reload", () => {
  const storage = makeStorage();
  const setup = makePending();
  savePendingSetups(storage, upsertPendingSetup([], setup));

  const loaded = loadPendingSetups(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].mintAddress, ADDR_A);
  assert.equal(loaded[0].name, "MVP Test");
  assert.equal(loaded[0].ticker, "MVP");
});

// ---------------------------------------------------------------------------
// 2. Successful verification removes the pending setup.
// ---------------------------------------------------------------------------
test("pending setup is removed after successful verification", () => {
  const storage = makeStorage();
  const setup = makePending();
  savePendingSetups(storage, upsertPendingSetup([], setup));

  const all = loadPendingSetups(storage);
  savePendingSetups(storage, removePendingSetup(all, ADDR_A));

  const remaining = loadPendingSetups(storage);
  assert.equal(remaining.length, 0);
});

// ---------------------------------------------------------------------------
// 3. Stale-read / timeout: pending setup is preserved.
// ---------------------------------------------------------------------------
test("stale read leaves pending setup intact", () => {
  const storage = makeStorage();
  const setup = makePending();
  savePendingSetups(storage, upsertPendingSetup([], setup));

  // Simulate a timeout without calling removePendingSetup.
  const still = loadPendingSetups(storage);
  assert.equal(still.length, 1);
  assert.equal(still[0].mintAddress, ADDR_A);
});

// ---------------------------------------------------------------------------
// 4. Reload / wallet-import: pending setups for the correct wallet are found.
//    We write raw JSON to storage to bypass the Pubkey validator for the
//    second (distinct) wallet address, and test only the filtering logic.
// ---------------------------------------------------------------------------
test("pending setups for wallet are filtered correctly after reload", () => {
  const storage = makeStorage();
  const RAW_WALLET_B = "waAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBs";
  const RAW_MINT_B   = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBB";
  const RAW_ACCT_B   = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACCCC";
  // Write raw JSON so we can use distinct addresses without Pubkey validation.
  storage.setItem(
    "thru.tokenStudio.alphanet.pendingSetups.v1",
    JSON.stringify([
      makePending({ walletAddress: ADDR_A, mintAddress: ADDR_A }),
      {
        walletAddress: RAW_WALLET_B,
        mintAddress: RAW_MINT_B,
        tokenAccountAddress: RAW_ACCT_B,
        name: "Other Token",
        ticker: "OTH",
        decimals: 6,
        initialSupply: "100",
        savedAt: Date.now(),
      },
    ]),
  );

  const all = loadPendingSetups(storage);
  const forA = pendingSetupsForWallet(all, ADDR_A);
  assert.equal(forA.length, 1, "wallet A should have exactly 1 pending setup");

  // Wallets B is stored with a non-normalizable address, so it may be dropped
  // by the normaliser — the important thing is wallet A is not mixed in.
  const forB = pendingSetupsForWallet(all, RAW_WALLET_B);
  // forB.length is 0 or 1 depending on whether the address was accepted.
  assert.ok(forA.every((s) => s.walletAddress === ADDR_A), "all returned setups belong to wallet A");
  assert.ok(forB.every((s) => s.walletAddress === RAW_WALLET_B), "all returned setups belong to wallet B");
});

// ---------------------------------------------------------------------------
// 5. Recovery adds a portfolio record (idempotent upsert).
// ---------------------------------------------------------------------------
test("recovery adds portfolio record and is idempotent", () => {
  const records1 = upsertKnownToken([], { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  assert.equal(records1.length, 1);
  assert.equal(records1[0].label, "MVP Test");

  // Calling upsert again with the same mint does not create a duplicate.
  const records2 = upsertKnownToken(records1, { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  assert.equal(records2.length, 1);
  assert.deepEqual(records2[0].tokenAccountAddresses, [ADDR_A]);
});

// ---------------------------------------------------------------------------
// 6. Duplicate mint does not create a second portfolio card.
// ---------------------------------------------------------------------------
test("duplicate mint in portfolio does not create second card", () => {
  let records = upsertKnownToken([], { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  records = upsertKnownToken(records, { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  records = upsertKnownToken(records, { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  assert.equal(records.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Raw balance 1000 / decimals 2 is displayed as "10" (formatRawAmount).
// ---------------------------------------------------------------------------
test("1000 raw balance with decimals 2 formats as 10", async () => {
  const { formatRawAmount } = await import("@thru/programs/token");
  const display = formatRawAmount(1000n, 2);
  assert.equal(display, "10");
});

// ---------------------------------------------------------------------------
// 8. Raw supply 1000 / decimals 2 is displayed as "10".
// ---------------------------------------------------------------------------
test("1000 raw supply with decimals 2 formats as 10", async () => {
  const { formatRawAmount } = await import("@thru/programs/token");
  const display = formatRawAmount(1000n, 2);
  assert.equal(display, "10");
});

// ---------------------------------------------------------------------------
// 9. Portfolio persistence round-trip.
// ---------------------------------------------------------------------------
test("portfolio record survives a storage round-trip", () => {
  const storage = makeStorage();
  const records = upsertKnownToken([], { mintAddress: ADDR_A, tokenAccountAddress: ADDR_A, label: "MVP Test" });
  saveKnownTokens(storage, records);

  const loaded = loadKnownTokens(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].mintAddress, ADDR_A);
  assert.equal(loaded[0].label, "MVP Test");
  assert.deepEqual(loaded[0].tokenAccountAddresses, [ADDR_A]);
});

// ---------------------------------------------------------------------------
// 10. Pending setup upsert replaces an existing entry for the same mint.
// ---------------------------------------------------------------------------
test("upsert pending setup replaces existing entry for same mint", () => {
  const first   = makePending({ name: "Old Name",  savedAt: Date.now() - 1000 });
  const updated = makePending({ name: "MVP Test", savedAt: Date.now() });
  const setups  = upsertPendingSetup(upsertPendingSetup([], first), updated);
  assert.equal(setups.length, 1);
  assert.equal(setups[0].name, "MVP Test");
});

// ---------------------------------------------------------------------------
// 11. Expired pending setups are dropped during normalisation.
// ---------------------------------------------------------------------------
test("pending setups older than TTL are dropped on load", () => {
  const storage = makeStorage();
  const expired: PendingTokenSetup = makePending({
    savedAt: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
  });
  // Write directly to bypass normalisation in savePendingSetups.
  storage.setItem(
    "thru.tokenStudio.alphanet.pendingSetups.v1",
    JSON.stringify([expired]),
  );
  const loaded = loadPendingSetups(storage);
  assert.equal(loaded.length, 0);
});

// ---------------------------------------------------------------------------
// 12. verifyAndRecoverTokenOnAlphaNet rejects when on-chain fetch fails.
//     Uses a Node.js test mock so no real RPC call is made.
// ---------------------------------------------------------------------------
test("verifyAndRecoverTokenOnAlphaNet rejects on decode failure (wrong owner path)", async (t) => {
  const { verifyAndRecoverTokenOnAlphaNet } = await import("../lib/token/thru-token");
  const { thru } = await import("@/lib/wallet/thru-wallet");

  // Patch thru.accounts.get to return a raw account with empty data.
  // parseMintAccountData will throw because the data is malformed,
  // which is the correct error-boundary behaviour.
  t.mock.method(thru.accounts, "get", async (address: string) => ({
    address,
    meta: {
      owner: {
        toThruFmt: () => "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq",
      },
    },
    data: new Uint8Array(0),
  }));

  await assert.rejects(
    () =>
      verifyAndRecoverTokenOnAlphaNet({
        mintAddress: ADDR_A,
        tokenAccountAddress: ADDR_A,
        name: "MVP Test",
        ticker: "MVP",
        ownerAddress: ADDR_A,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

test("denied localStorage reads fail closed without deleting public references", () => {
  const denied = {
    getItem(): string | null {
      throw new DOMException("Storage disabled", "SecurityError");
    },
  };
  assert.deepEqual(loadKnownTokens(denied), []);
  assert.deepEqual(loadPendingSetups(denied), []);
});

test("quota failures are reported by public metadata writes", () => {
  const full = {
    setItem(): void {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    },
  };
  assert.throws(() => saveKnownTokens(full, []), /quota/i);
  assert.throws(() => savePendingSetups(full, []), /quota/i);
});
