import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchTokenPortfolioOnAlphaNet,
  type TokenPortfolioItem,
} from "./thru-token";
import {
  LatestRequestTracker,
  loadKnownTokens,
  saveKnownTokens,
  upsertKnownToken,
  type KnownTokenRecord,
} from "./portfolio";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

export function useTokenPortfolio(account: ThruAccount | null) {
  const [records, setRecords] = useState<KnownTokenRecord[]>([]);
  const [portfolio, setPortfolio] = useState<TokenPortfolioItem[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const requestTrackerRef = useRef(new LatestRequestTracker());

  const refreshRecords = useCallback(async (next: KnownTokenRecord[]) => {
    const request = requestTrackerRef.current.begin();
    setRefreshing(true);
    setPortfolioError(null);
    try {
      const filtered = next.filter(r => !r.walletAddress || r.walletAddress === account?.address);
      const nextPortfolio = await fetchTokenPortfolioOnAlphaNet(filtered);
      if (!requestTrackerRef.current.isCurrent(request)) return;
      setPortfolio(nextPortfolio);
    } catch (error) {
      if (!requestTrackerRef.current.isCurrent(request)) return;
      setPortfolioError(
        error instanceof Error ? error.message : "Portfolio refresh failed.",
      );
    } finally {
      if (requestTrackerRef.current.isCurrent(request)) {
        setRefreshing(false);
      }
    }
  }, [account?.address]);

  const persistAndRefresh = useCallback(
    (next: KnownTokenRecord[]) => {
      saveKnownTokens(window.localStorage, next);
      setRecords(next);
      void refreshRecords(next);
    },
    [refreshRecords],
  );

  useEffect(() => {
    const loaded = loadKnownTokens(window.localStorage);
    setRecords(loaded);
    setStorageReady(true);
    void refreshRecords(loaded);
  }, [account?.address, refreshRecords]);

  useEffect(() => {
    const tracker = requestTrackerRef.current;
    return () => {
      tracker.invalidate();
    };
  }, []);

  const addKnownToken = useCallback((mintAddress: string, tokenAccountAddress: string, label: string) => {
    const next = upsertKnownToken(records, {
      mintAddress,
      tokenAccountAddress,
      label,
      walletAddress: account?.address,
    });
    persistAndRefresh(next);
  }, [records, account?.address, persistAndRefresh]);

  const removeKnownToken = useCallback((mintAddress: string) => {
    const next = records.filter(r => r.mintAddress !== mintAddress);
    persistAndRefresh(next);
  }, [records, persistAndRefresh]);

  const clearExternalAssets = useCallback((activeWalletAddress?: string) => {
    const externalMints = new Set(portfolio.filter(item => {
      if (item.walletAddress && activeWalletAddress && item.walletAddress !== activeWalletAddress) {
        return true;
      }
      const hasActiveAccount = activeWalletAddress && item.tokenAccounts.some(acc => acc.state?.owner === activeWalletAddress);
      const isMintAuthority = activeWalletAddress && item.mint?.mintAuthority === activeWalletAddress;
      return !hasActiveAccount && !isMintAuthority;
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
    refreshRecords,
    persistAndRefresh,
    addKnownToken,
    removeKnownToken,
    clearExternalAssets,
  };
}
