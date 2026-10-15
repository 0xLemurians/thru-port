// Public synthetic observations only. No wallet generation or signing material.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Pubkey } from "@thru/sdk";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import { useTokenPortfolio } from "../../lib/token/portfolio-hook";
import { buildWalletPortfolio, unknownObservation, type PortfolioNetworkStatus } from "../../lib/portfolio/asset-model";
import type { ThruAccount } from "../../lib/wallet/thru-wallet";
import type { DiscoveryResult, VerifiedHolding } from "../../lib/token/discovery";
import type { TokenPortfolioItem } from "../../lib/token/thru-token";
import type { KnownTokenRecord } from "../../lib/token/portfolio";
import CommandDashboard from "../../components/command/CommandDashboard";
import CommandShell from "../../components/command/CommandShell";
import TokenStudio from "../../components/TokenStudio";
import { THRU_NETWORK } from "../../lib/thru/network";

const addr = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
export const ids = { wallet: addr(40), other: addr(41), mint: addr(42), first: addr(43), custom: addr(44),
  secondMint: addr(45), creatorMint: addr(47), authorityMint: addr(48), savedMint: addr(50), walletBMint: addr(60) };
let reads = 0, createdReads = 0, portfolioReads = 0, continuations = 0, writes = 0, secretReads = 0, sends = 0, deferred = false;
let phase: "live" | "frozen" | "provisional" | "missing-source" | "unavailable" | "exhausted" | "failed" | "zero" | "expired" | "unknown-balance" = "live";
type MockSend = { selectedTokenMint: string; transferSource: string; transferDestination: string; transferAmount: string };
let lastSend: MockSend | null = null;
let transferState = { busy: false, progressLabel: null as string | null, error: null as string | null };
const transferListeners = new Set<() => void>();
let resolvers: (() => void)[] = [];
let lateSuccess: (() => void) | undefined;
const mint = (creator = ids.other, authority = ids.other) => ({ creator, mintAuthority: authority, freezeAuthority: null,
  hasFreezeAuthority: false, decimals: 6, supply: 16_000_000n, ticker: "SAME" });
function group(wallet: string, second = false, observationPhase = phase): VerifiedHolding {
  const mintAddress = wallet === ids.wallet ? (second ? ids.secondMint : ids.mint) : addr(second ? 61 : 60);
  const at = Date.now() - (observationPhase === "expired" ? 120_000 : 0);
  return { mintAddress, mint: mint(), mintFinality: observationPhase === "provisional" ? "provisional" : "authoritative",
    mintSlot: "100", mintSeq: "1", verifiedAt: at,
    accounts: (second ? [addr(46)] : observationPhase === "missing-source" ? [ids.first] : [ids.first, ids.custom]).map((address, index) => ({
      address, state: { owner: wallet, mint: mintAddress, amount: observationPhase === "zero" ? 0n : index ? 9_000_000n : 7_000_000n, isFrozen: observationPhase === "frozen" },
      finality: observationPhase === "provisional" ? "provisional" : "authoritative", slot: "100", seq: "1", verifiedAt: at })) };
}
const records = (wallet: string): KnownTokenRecord[] => [
  { walletAddress: wallet, mintAddress: ids.creatorMint, tokenAccountAddresses: [], label: "Creator only - Long local label for narrow portfolio rows" },
  { walletAddress: wallet, mintAddress: ids.authorityMint, tokenAccountAddresses: [], label: "Authority only" },
  { walletAddress: wallet, mintAddress: ids.savedMint, tokenAccountAddresses: [], label: "Saved unconfirmed" },
];

export const boundary = {
  async discover(wallet: string, options?: { continuation?: { cursor: string | null } | null }): Promise<DiscoveryResult> {
    reads++;
    if (options?.continuation?.cursor) continuations++;
    const network = THRU_NETWORK.storageScope, observationPhase = phase;
    if (deferred) await new Promise<void>((resolve) => resolvers.push(resolve));
    if (observationPhase === "failed") throw new Error("Synthetic transport failure: do not render internal details");
    return { walletAddress: wallet, network, holdings: observationPhase === "unavailable" ? [] : [group(wallet, false, observationPhase), group(wallet, true, observationPhase)],
      state: observationPhase === "unavailable" ? "unavailable" : observationPhase === "exhausted" ? "exhausted" : "partial", pagesInspected: 1,
      accountsInspected: 3, candidateReadFailures: 0, verifiedAt: Date.now(), diagnostics: [], continuation: observationPhase === "exhausted" ? null : {
        version: 1, walletAddress: wallet, network, program: BOOTSTRAP_PROGRAM_ADDRESSES.token,
        cursor: "next", seenCursors: ["next"], pendingAddresses: [], inventoryExhausted: false } };
  },
  created: async (wallet: string) => { createdReads++; return records(wallet); },
  async portfolio(input: KnownTokenRecord[]): Promise<TokenPortfolioItem[]> {
    portfolioReads++;
    return input.map((record) => ({ ...record, tokenAccounts: [],
      ...(record.mintAddress === ids.savedMint ? { error: "Unavailable" } : {
        mint: record.mintAddress === ids.creatorMint ? mint(record.walletAddress) : mint(ids.other, record.walletAddress),
        ...(phase === "unknown-balance" && record.mintAddress === ids.creatorMint
          ? { tokenAccounts: [{ address: addr(51), error: "Account data unavailable" }] } : {}),
      }) }));
  },
  forbid() { writes++; throw new Error("Test boundary forbids RPC, signing and writes"); },
  send(args: MockSend, success?: () => void) { sends++; lastSend = args; lateSuccess = success; success?.(); },
  transferSnapshot: () => transferState,
  subscribe(listener: () => void) { transferListeners.add(listener); return () => { transferListeners.delete(listener); }; },
};

export interface PortfolioQA {
  ids: typeof ids;
  stats(): { reads: number; createdReads: number; portfolioReads: number; continuations: number; writes: number; secretReads: number; sends: number; lastSend: MockSend | null };
  wallet(value: "a" | "b" | "none"): void;
  health(value: PortfolioNetworkStatus): void;
  balance(value: string | null): void;
  phase(value: typeof phase): void;
  defer(value: boolean): void;
  release(): void;
  releaseOne(index: number): void;
  refresh(): void;
  network(alternate: boolean): void;
  lateSuccess(): void;
  transferState(busy: boolean, error?: string): void;
  unmount(): void;
}
declare global { interface Window { portfolioQA: PortfolioQA; } }
function publicAccount(address: string): ThruAccount {
  return { address, publicKey: Pubkey.from(address).toBytes(),
    get privateKey(): never { secretReads++; throw new Error("Private fields forbidden in portfolio rendering"); },
    get mnemonic(): never { secretReads++; throw new Error("Private fields forbidden in portfolio rendering"); } };
}
const wallets = { a: publicAccount(ids.wallet), b: publicAccount(ids.other) };
const root = createRoot(document.getElementById("root")!);
function Harness() {
  const [identity, setIdentity] = useState<"a" | "b" | "none">("a");
  const [status, setStatus] = useState<PortfolioNetworkStatus>("Online");
  const [balance, setBalance] = useState<bigint | null>(0n);
  const [stage, setStage] = useState<"account" | "token" | "name">("account");
  const [, renderNetwork] = useState(0);
  const account = identity === "none" ? null : wallets[identity];
  const hook = useTokenPortfolio(account, { networkStatus: status });
  const scope = { networkId: THRU_NETWORK.id, chainId: THRU_NETWORK.expectedChainId, walletAddress: account?.address ?? ids.wallet };
  const model = account ? buildWalletPortfolio({ scope, tokens: hook.modelSnapshot ?? null, now: Date.now(), networkStatus: status,
    native: balance === null ? null : { scope, availability: "available", rawBalance: balance,
      observation: { ...unknownObservation(), source: "rpc", observedAt: Date.now(), finality: "provisional" } } }) : null;
  const health = { status, lastChecked: null, checkNow: () => {} };
  window.portfolioQA = { ids, stats: () => ({ reads, createdReads, portfolioReads, continuations, writes, secretReads, sends, lastSend }), wallet: setIdentity, health: setStatus,
    balance: (value) => setBalance(value === null ? null : BigInt(value)), phase: (value) => { phase = value; },
    defer: (value) => { deferred = value; }, release: () => { const pending = resolvers; resolvers = []; pending.forEach((resolve) => resolve()); },
    releaseOne: (index) => resolvers.splice(index, 1)[0]?.(), refresh: () => { void hook.refreshRecords(hook.records); },
    network: (alternate) => {
      // Test bundler alone makes the descriptor mutable; production remains frozen.
      Object.assign(THRU_NETWORK, { id: alternate ? "testnet" : "betanet", expectedChainId: alternate ? 3 : 2,
        storageScope: alternate ? "testnet:3" : "betanet:2" });
      setBalance(null); renderNetwork((revision) => revision + 1);
    },
    lateSuccess: () => lateSuccess?.(),
    transferState: (busy, error) => { transferState = { busy, progressLabel: busy ? "Confirming mocked transfer" : null, error: error ?? null };
      transferListeners.forEach((listener) => listener()); }, unmount: () => root.unmount() };
  return <CommandShell accountAvailable={!!account} currentStage={stage} onStageChange={setStage} health={health}>
    {stage === "account" ? <CommandDashboard account={account} balance={balance} balanceError={null} walletBusy={false} walletError={null}
      onCreateWallet={boundary.forbid} onImportWallet={boundary.forbid} onImportBackup={boundary.forbid}
      health={health} portfolioHook={hook} portfolioModel={model} onForgetAccount={boundary.forbid} /> :
      <TokenStudio account={account} health={health} portfolioHook={hook} portfolioModel={model} />}
  </CommandShell>;
}
root.render(<Harness />);
