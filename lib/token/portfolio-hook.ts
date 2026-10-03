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
} from "./portfolio";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkStatus } from "@/components/port/useNetworkHealth";
import {
  safeTokenReadError,
  tokenNetworkReadAllowed,
} from "@/lib/token/network-state";

interface UseTokenPortfolioOptions {
  networkStatus?: NetworkStatus;
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

  const requestTrackerRef = useRef(new LatestRequestTracker());
  const requestAbortRef = useRef<AbortController | null>(null);
  const networkReadAllowed = tokenNetworkReadAllowed(options.networkStatus);

  const refreshRecords = useCallback(async (next: KnownTokenRecord[]) => {
    const walletAddress = account?.address;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if (!walletAddress || !networkReadAllowed) {
      requestTrackerRef.current.invalidate();
      setPortfolio([]);
      setRefreshing(false);
      setPortfolioError(null);
      return;
    }

    const request = requestTrackerRef.current.begin();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setRefreshing(true);
    setPortfolioError(null);
    let recordsToRefresh = next;
    let discoveryError: string | null = null;
    try {
      try {
        const discovered = await discoverCreatedTokensOnce(walletAddress);
        if (
          controller.signal.aborted ||
          !requestTrackerRef.current.isCurrent(request)
        ) {
          return;
        }
        recordsToRefresh = mergeCreatedTokenRecords(
          next,
          discovered,
          walletAddress,
        );
        try {
          saveKnownTokens(window.localStorage, recordsToRefresh);
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
      });
      if (!requestTrackerRef.current.isCurrent(request)) return;
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
        saveKnownTokens(window.localStorage, enrichedRecords);
        setPersistenceWarning(null);
      } catch {
        setPersistenceWarning(
          "On-chain token state is available, but this browser could not save the public token list.",
        );
      }
      setRecords(enrichedRecords);
      setPortfolio(controlledPortfolio);
      setPortfolioError(
        discoveryError ??
          (nextPortfolio.some((item) => item.error)
            ? safeTokenReadError(new Error("Token state read failed."))
            : null),
      );
    } catch (error) {
      if (!requestTrackerRef.current.isCurrent(request)) return;
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
  }, [account?.address, networkReadAllowed]);

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
    const loaded = loadKnownTokens(window.localStorage);
    setRecords(loaded);
    setStorageReady(true);
    if (networkReadAllowed) {
      void refreshRecords(loaded);
    } else {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      requestTrackerRef.current.invalidate();
      setPortfolio([]);
      setRefreshing(false);
      setPortfolioError(null);
    }
  }, [account?.address, networkReadAllowed, refreshRecords]);

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
    portfolio,
    storageReady,
    refreshing,
    portfolioError,
    persistenceWarning,
    refreshRecords,
    persistAndRefresh,
    addKnownToken,
    removeKnownToken,
    clearExternalAssets,
  };
}

export type TokenPortfolioHook = ReturnType<typeof useTokenPortfolio>;
