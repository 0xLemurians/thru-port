import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { BuildTransactionOptions, Transaction } from "@thru/sdk";
import {
  BOOTSTRAP_FAUCET_VAULT_ADDRESS,
  BOOTSTRAP_PROGRAM_ADDRESSES,
} from "@thru/programs/bootstrap-addresses";
import {
  explorerAddressUrl,
  explorerHomeUrl,
  explorerTransactionUrl,
  THRU_NETWORK,
} from "../lib/thru/network";
import { THRU_RPC_URL } from "../lib/thru/client";
import {
  assertUsableTransactionContext,
  buildTransactionForSigning,
} from "../lib/thru/transactions";
import {
  FAUCET_ACCOUNT_ADDRESS,
  FAUCET_PROGRAM_ADDRESS,
  FAUCET_TRANSACTION_RESOURCES,
} from "../lib/wallet/faucet";
import {
  LEGACY_ALPHANET_TOKEN_PORTFOLIO_STORAGE_KEY,
  TOKEN_PORTFOLIO_STORAGE_KEY,
  loadKnownTokens,
} from "../lib/token/portfolio";
import {
  LEGACY_ALPHANET_PENDING_SETUP_STORAGE_KEY,
  PENDING_SETUP_STORAGE_KEY,
  loadPendingSetups,
} from "../lib/token/pending-setup";
import {
  LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
  PENDING_TOKEN_OPERATION_STORAGE_KEY,
} from "../lib/token/pending-operation";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function transactionOptions(): BuildTransactionOptions {
  return {
    feePayer: { publicKey: new Uint8Array(32).fill(1) },
    program: new Uint8Array(32).fill(2),
    header: {
      fee: 0n,
      expiryAfter: 100,
      computeUnits: 1,
      stateUnits: 0,
      memoryUnits: 1,
    },
  };
}

test("Betanet is the single centralized production network", () => {
  assert.deepEqual(THRU_NETWORK, {
    id: "betanet",
    displayName: "Betanet",
    rpcUrl: "https://rpc.betanet.thru.org",
    expectedChainId: 2,
    explorerBaseUrl: "https://scan.thru.org",
    explorerQuery: "network=betanet",
    storageScope: "betanet:2",
  });
  assert.equal(THRU_RPC_URL, THRU_NETWORK.rpcUrl);

  const nextConfig = readFileSync(
    path.join(process.cwd(), "next.config.mjs"),
    "utf8",
  );
  assert.match(nextConfig, /https:\/\/rpc\.betanet\.thru\.org/);
  assert.doesNotMatch(nextConfig, /rpc\.alphanet\.thru\.org/);
});

test("Betanet Explorer links are scoped and user values are encoded", () => {
  assert.equal(explorerHomeUrl(), "https://scan.thru.org/?network=betanet");
  assert.equal(
    explorerAddressUrl("address/value"),
    "https://scan.thru.org/address/address%2Fvalue?network=betanet",
  );
  assert.equal(
    explorerTransactionUrl("signature?value"),
    "https://scan.thru.org/tx/signature%3Fvalue?network=betanet",
  );
});

test("write context is discovered by the SDK builder and must match Betanet", async () => {
  let buildCalls = 0;
  const transaction = {
    chainId: THRU_NETWORK.expectedChainId,
    startSlot: 123n,
  } as unknown as Transaction;
  const built = await buildTransactionForSigning(
    transactionOptions(),
    undefined,
    async () => {
      buildCalls += 1;
      return transaction;
    },
  );

  assert.equal(buildCalls, 1);
  assert.equal(built, transaction);
  assert.doesNotThrow(() => assertUsableTransactionContext(transaction));
  assert.throws(
    () => assertUsableTransactionContext({ chainId: 1, startSlot: 123n }),
    /does not match Betanet/,
  );
});

test("canonical v0.4.1 Betanet faucet addresses and resources are retained", () => {
  assert.equal(FAUCET_PROGRAM_ADDRESS, BOOTSTRAP_PROGRAM_ADDRESSES.faucet);
  assert.equal(FAUCET_ACCOUNT_ADDRESS, BOOTSTRAP_FAUCET_VAULT_ADDRESS);
  assert.deepEqual(FAUCET_TRANSACTION_RESOURCES, {
    computeUnits: 300_000,
    stateUnits: 0,
    memoryUnits: 10_000,
  });
});

test("public token and pending storage are isolated from legacy AlphaNet keys", () => {
  assert.match(TOKEN_PORTFOLIO_STORAGE_KEY, /\.betanet:2\.v1$/);
  assert.match(PENDING_SETUP_STORAGE_KEY, /\.betanet:2\.v1$/);
  assert.match(PENDING_TOKEN_OPERATION_STORAGE_KEY, /\.betanet:2\.v1$/);
  assert.notEqual(
    TOKEN_PORTFOLIO_STORAGE_KEY,
    LEGACY_ALPHANET_TOKEN_PORTFOLIO_STORAGE_KEY,
  );
  assert.notEqual(
    PENDING_SETUP_STORAGE_KEY,
    LEGACY_ALPHANET_PENDING_SETUP_STORAGE_KEY,
  );
  assert.notEqual(
    PENDING_TOKEN_OPERATION_STORAGE_KEY,
    LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
  );

  const storage = new MemoryStorage();
  storage.values.set(LEGACY_ALPHANET_TOKEN_PORTFOLIO_STORAGE_KEY, "[]");
  storage.values.set(LEGACY_ALPHANET_PENDING_SETUP_STORAGE_KEY, "[]");
  storage.values.set(
    LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
    "[]",
  );

  assert.deepEqual(loadKnownTokens(storage), []);
  assert.deepEqual(loadPendingSetups(storage), []);
  assert.deepEqual(storage.reads, [
    TOKEN_PORTFOLIO_STORAGE_KEY,
    PENDING_SETUP_STORAGE_KEY,
  ]);
  assert.equal(
    storage.values.has(LEGACY_ALPHANET_TOKEN_PORTFOLIO_STORAGE_KEY),
    true,
  );
  assert.equal(
    storage.values.has(LEGACY_ALPHANET_PENDING_SETUP_STORAGE_KEY),
    true,
  );
});

test("offline network changes clear stale wallet and portfolio read state", () => {
  const appFlow = readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  const portfolioHook = readFileSync(
    path.join(process.cwd(), "lib/token/portfolio-hook.ts"),
    "utf8",
  );

  assert.match(
    appFlow,
    /health\.status === "Online" \|\| health\.status === "Degraded"/,
  );
  assert.match(appFlow, /setBalance\(null\)/);
  assert.match(appFlow, /requestId !== balanceRequestRef\.current/);
  assert.match(appFlow, /balanceRequestRef\.current \+= 1/);
  assert.match(portfolioHook, /requestAbortRef\.current\?\.abort\(\)/);
  assert.match(portfolioHook, /requestTrackerRef\.current\.invalidate\(\)/);
  assert.match(portfolioHook, /setPortfolio\(\[\]\)/);
});
