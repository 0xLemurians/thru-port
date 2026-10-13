import { useCallback, useEffect, useRef, useState } from "react";
import {
  discoverControlledTokensOnBetanet,
  fetchTokenPortfolioOnBetanet,
  isCreatedTokenControlledByWallet,
  type TokenPortfolioItem,
} from "./thru-token";
import {
  createdTokensForWallet,
  LatestRequestTracker,
  loadKnownTokens,
  mergeCreatedTokenRecords,
  saveKnownTokens,
  upsertKnownToken,
  type KnownTokenRecord,
  mergeWalletPortfolio,
  tokenSendSources,
  observeTokenSourceExpiry,
} from "./portfolio";
import { DiscoveryRequestGuard, discoveryContinuationForRequest, discoverWalletHoldingsOnce, type DiscoveryContinuation, type DiscoveryResult, type VerifiedHolding } from "./discovery";
import { loadDiscoveryCache, mergeDiscoveryHoldings, publicDiscoveryStorage, saveDiscoveryCache } from "./discovery-cache";
import { THRU_NETWORK } from "../thru/network";
import { createThruAccountReader } from "../thru/client";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkStatus } from "@/components/port/useNetworkHealth";
import {
  safeTokenReadError,
  tokenNetworkReadAllowed,
} from "@/lib/token/network-state";

interface UseTokenPortfolioOptions {
  networkStatus?: NetworkStatus;
}

/** A UI-only expiry timer: no RPC, signing or transaction work. */
export function useTokenSendSources(item: TokenPortfolioItem | undefined, wallet: string) {
  const [revision, setRevision] = useState(0);
  useEffect(() => observeTokenSourceExpiry(item, wallet, () => setRevision((current) => current + 1)),
    [item, wallet, revision]);
  return tokenSendSources(item, wallet);
}

const discoveryInFlight = new Map<
  string,
  Promise<KnownTokenRecord[]>
>();

function discoverCreatedTokensOnce(
  walletAddress: string,
): Promise<KnownTokenRecord[]> {
  const existing = discoveryInFlight.get(walletAddress);
  if (existing) return existing;
  const pending = discoverControlledTokensOnBetanet(walletAddress).finally(
    () => {
      if (discoveryInFlight.get(walletAddress) === pending) {
        discoveryInFlight.delete(walletAddress);
      }
    },
  );
  discoveryInFlight.set(walletAddress, pending);
  return pending;
}

export function useTokenPortfolio(
  account: ThruAccount | null,
  options: UseTokenPortfolioOptions = {},
) {
  const [records, setRecords] = useState<KnownTokenRecord[]>([]);
  const [portfolio, setPortfolio] = useState<TokenPortfolioItem[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const discoveryRef = useRef<DiscoveryResult | null>(null);
  const snapshotsRef = useRef<{ wallet: string; all: VerifiedHolding[]; live: VerifiedHolding[] }>({ wallet: "", all: [], live: [] });
  const guardRef = useRef(new DiscoveryRequestGuard());
  const activeScope = (account?.address ?? "") + ":" + THRU_NETWORK.storageScope + ":" + String(options.networkStatus);
  const scopeRef = useRef(activeScope);
  scopeRef.current = activeScope;

  const requestTrackerRef = useRef(new LatestRequestTracker());
  const requestAbortRef = useRef<AbortController | null>(null);
  const networkReadAllowed = tokenNetworkReadAllowed(options.networkStatus) && options.networkStatus !== "Checking";

  const refreshRecords = useCallback(async (next: KnownTokenRecord[], continueScan = false, resume?: DiscoveryContinuation | null) => {
    const walletAddress = account?.address;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if (!walletAddress || !networkReadAllowed) {
      requestTrackerRef.current.invalidate();
      if (!walletAddress) setPortfolio([]);
      else setPortfolio(mergeWalletPortfolio(createdTokensForWallet(next, walletAddress).map((record) => ({
        ...record, error: "Saved created token; live state unavailable.", tokenAccounts: record.tokenAccountAddresses.map((address) => ({ address })),
      })), snapshotsRef.current.wallet === walletAddress ? snapshotsRef.current.all : [], [], walletAddress));
      setRefreshing(false);
      setPortfolioError(null);
      return;
    }

    const request = requestTrackerRef.current.begin();
    const job = guardRef.current.begin(activeScope);
    const controller = job.controller;
    requestAbortRef.current = controller;
    const current = () => job.isCurrent() && requestTrackerRef.current.isCurrent(request) && scopeRef.current === activeScope;
    setRefreshing(true);
    setPortfolioError(null);
    let recordsToRefresh = next;
    let discoveryError: string | null = null;
    try {
      const storage = publicDiscoveryStorage();
      const cached = loadDiscoveryCache(storage, walletAddress);
      const before = snapshotsRef.current.wallet === walletAddress ? snapshotsRef.current.all : [];
      const all = mergeDiscoveryHoldings(cached.value?.holdings ?? [], before);
      snapshotsRef.current = { wallet: walletAddress, all,
        live: continueScan && snapshotsRef.current.wallet === walletAddress ? snapshotsRef.current.live : [] };
      if (cached.status === "corrupt" || cached.status === "unavailable") {
        setDiscoveryWarning("Public holdings cache is unavailable. Existing created-token records are preserved.");
      }
      const previousContinuation = discoveryRef.current?.walletAddress === walletAddress
        ? discoveryRef.current.continuation : cached.value?.continuation;
      // Restore can resume its persisted cursor. Explicit Refresh restarts inventory
      // but keeps unresolved candidates, rather than losing them at the checkpoint.
      const continuation = discoveryContinuationForRequest(resume !== undefined ? resume : previousContinuation,
        walletAddress, resume !== undefined || continueScan);
      const result = await discoverWalletHoldingsOnce(walletAddress, { signal: controller.signal, continuation });
      if (!current()) return;
      const combined = mergeDiscoveryHoldings(all, result.holdings);
      const live = continueScan ? mergeDiscoveryHoldings(snapshotsRef.current.live, result.holdings) : result.holdings;
      snapshotsRef.current = { wallet: walletAddress, all: combined, live };
      setDiscovery(result);
      discoveryRef.current = result;
      const cachedCreated = createdTokensForWallet(next, walletAddress).map((record): TokenPortfolioItem => ({
        ...record, error: "Saved created token; live state has not been refreshed.", tokenAccounts: record.tokenAccountAddresses.map((address) => ({ address })),
      }));
      setPortfolio(mergeWalletPortfolio(cachedCreated, combined, live, walletAddress));
      if (result.state !== "unavailable") {
        const saved = saveDiscoveryCache(storage, { version: 1, network: THRU_NETWORK.storageScope,
          chainId: THRU_NETWORK.expectedChainId, walletAddress, holdings: combined, continuation: result.continuation, savedAt: result.verifiedAt });
        setDiscoveryWarning(saved === "ok" ? null : saved === "limited"
          ? "Public holdings cache limit reached. Unsaved live results remain visible; previous cache is preserved."
          : "Holdings are readable, but this browser could not save the public discovery cache.");
      }
      try {
        const discovered = continueScan ? [] : await discoverCreatedTokensOnce(walletAddress);
        if (
          controller.signal.aborted ||
          !current()
        ) {
          return;
        }
        recordsToRefresh = mergeCreatedTokenRecords(
          next,
          discovered,
          walletAddress,
        );
        try {
          if (!storage) throw new Error("Storage unavailable");
          saveKnownTokens(storage, recordsToRefresh);
          setPersistenceWarning(null);
        } catch {
          setPersistenceWarning(
            "On-chain token state is available, but this browser could not save the public token list.",
          );
        }
        setRecords(recordsToRefresh);
      } catch (error) {
        if (controller.signal.aborted) return;
        discoveryError = safeTokenReadError(error);
      }

      const filtered = createdTokensForWallet(
        recordsToRefresh,
        walletAddress,
      );
      const nextPortfolio = await fetchTokenPortfolioOnBetanet(filtered, {
        signal: controller.signal,
        readAccount: (address) => createThruAccountReader(controller.signal, 4000).get(address),
      });
      if (!current()) return;
      const controlledPortfolio = nextPortfolio.filter(
        (item) =>
          isCreatedTokenControlledByWallet(item, walletAddress) ||
          (item.walletAddress === walletAddress && Boolean(item.error)),
      );
      let enrichedRecords = recordsToRefresh;
      for (const item of controlledPortfolio) {
        if (!item.mint) continue;
        enrichedRecords = upsertKnownToken(enrichedRecords, {
          mintAddress: item.mintAddress,
          walletAddress,
          label: item.label,
          creatorAddress: item.mint.creator,
          mintAuthorityAddress: item.mint.mintAuthority,
          ticker: item.mint.ticker,
          decimals: item.mint.decimals,
        });
      }
      try {
        if (!storage) throw new Error("Storage unavailable");
        saveKnownTokens(storage, enrichedRecords);
        setPersistenceWarning(null);
      } catch {
        setPersistenceWarning(
          "On-chain token state is available, but this browser could not save the public token list.",
        );
      }
      setRecords(enrichedRecords);
      setPortfolio(mergeWalletPortfolio(controlledPortfolio, combined, live, walletAddress));
      setPortfolioError(
        discoveryError ??
          (nextPortfolio.some((item) => item.error)
            ? safeTokenReadError(new Error("Token state read failed."))
            : null),
      );
    } catch (error) {
      if (!current()) return;
      if (controller.signal.aborted) return;
      setPortfolioError(safeTokenReadError(error));
    } finally {
      if (requestTrackerRef.current.isCurrent(request)) {
        setRefreshing(false);
      }
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
      }
    }
  }, [account?.address, networkReadAllowed, activeScope]);

  const persistAndRefresh = useCallback(
    (next: KnownTokenRecord[]) => {
      try {
        saveKnownTokens(window.localStorage, next);
        setPersistenceWarning(null);
      } catch {
        setPersistenceWarning(
          "On-chain token state is available, but this browser could not save the public token list.",
        );
      }
      setRecords(next);
      void refreshRecords(next);
    },
    [refreshRecords],
  );

  useEffect(() => {
    const storage = publicDiscoveryStorage();
    const loaded = storage ? loadKnownTokens(storage) : [];
    setRecords(loaded);
    setStorageReady(true);
    const wallet = account?.address;
    const requestGuard = guardRef.current, requestTracker = requestTrackerRef.current;
    const cached = wallet ? loadDiscoveryCache(storage, wallet) : null;
    const sameWallet = snapshotsRef.current.wallet === wallet;
    const inMemory = sameWallet ? snapshotsRef.current.all : [];
    const checkpoint = sameWallet && discoveryRef.current?.walletAddress === wallet
      ? discoveryRef.current.continuation : cached?.value?.continuation;
    setDiscoveryWarning(cached?.status === "corrupt" || cached?.status === "unavailable"
      ? "Public holdings cache is unavailable. Existing created-token records are preserved." : null);
    setPersistenceWarning(null);
    // A storage failure must not discard the session's verified public snapshot
    // when health turns offline. It is retained as stale, never as Send authority.
    snapshotsRef.current = { wallet: wallet ?? "", all: mergeDiscoveryHoldings(cached?.value?.holdings ?? [], inMemory), live: [] };
    const restoredDiscovery: DiscoveryResult | null = wallet && checkpoint ? {
      walletAddress: wallet, network: THRU_NETWORK.storageScope, holdings: [], state: "partial", continuation: checkpoint,
      pagesInspected: 0, accountsInspected: 0, candidateReadFailures: checkpoint.pendingAddresses.length,
      verifiedAt: cached?.value?.savedAt ?? 0, diagnostics: [],
    } : null;
    setDiscovery(restoredDiscovery);
    discoveryRef.current = restoredDiscovery;
    if (wallet) setPortfolio(mergeWalletPortfolio(createdTokensForWallet(loaded, wallet).map((record) => ({
      ...record, error: "Saved created token; live state unavailable.", tokenAccounts: record.tokenAccountAddresses.map((address) => ({ address })),
    })), snapshotsRef.current.all, [], wallet));
    else setPortfolio([]);
    if (networkReadAllowed) {
      void refreshRecords(loaded, false, checkpoint ?? null);
    } else {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      requestTrackerRef.current.invalidate();
      setRefreshing(false);
      setPortfolioError(null);
    }
    return () => { requestAbortRef.current?.abort(); requestGuard.cancel(); requestTracker.invalidate(); };
  }, [account?.address, networkReadAllowed, activeScope, refreshRecords]);

  useEffect(() => {
    const tracker = requestTrackerRef.current;
    return () => {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      tracker.invalidate();
    };
  }, []);

  const addKnownToken = useCallback((
    mintAddress: string,
    tokenAccountAddress: string,
    label: string,
    metadata: {
      creatorAddress?: string;
      mintAuthorityAddress?: string;
      ticker?: string;
      decimals?: number;
    } = {},
  ) => {
    const next = upsertKnownToken(records, {
      mintAddress,
      tokenAccountAddress,
      label,
      walletAddress: account?.address,
      ...metadata,
    });
    persistAndRefresh(next);
  }, [records, account?.address, persistAndRefresh]);

  const removeKnownToken = useCallback((mintAddress: string) => {
    const next = records.filter(
      (record) =>
        record.mintAddress !== mintAddress ||
        record.walletAddress !== account?.address,
    );
    persistAndRefresh(next);
  }, [records, account?.address, persistAndRefresh]);

  const clearExternalAssets = useCallback((activeWalletAddress?: string) => {
    const externalMints = new Set(portfolio.filter(item => {
      if (item.walletAddress && activeWalletAddress && item.walletAddress !== activeWalletAddress) {
        return true;
      }
      const isCreator = activeWalletAddress && item.mint?.creator === activeWalletAddress;
      const isMintAuthority = activeWalletAddress && item.mint?.mintAuthority === activeWalletAddress;
      return !isCreator && !isMintAuthority;
    }).map(item => item.mintAddress));
    
    const next = records.filter(r => !externalMints.has(r.mintAddress));
    persistAndRefresh(next);
  }, [portfolio, records, persistAndRefresh]);

  return {
    records,
    portfolio: portfolio.filter((item) => item.walletAddress === account?.address),
    storageReady,
    refreshing,
    portfolioError,
    persistenceWarning,
    refreshRecords,
    persistAndRefresh,
    addKnownToken,
    removeKnownToken,
    clearExternalAssets,
    discovery: discovery?.walletAddress === account?.address ? discovery : null,
    discoveryWarning,
    continueDiscovery: () => { if (!refreshing) void refreshRecords(records, true); },
  };
}

type FullPortfolioHook = ReturnType<typeof useTokenPortfolio>;
export type TokenPortfolioHook = Omit<FullPortfolioHook, "discovery" | "discoveryWarning" | "continueDiscovery"> &
  Partial<Pick<FullPortfolioHook, "discovery" | "discoveryWarning" | "continueDiscovery">>;
