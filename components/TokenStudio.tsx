"use client";

import { useState, useEffect } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioHook } from "@/lib/token/portfolio-hook";
import type { CreateTokenResult } from "@/lib/token/thru-token";
import {
  safeTokenReadError,
  tokenNetworkActionsDisabled,
  tokenNetworkWarning,
} from "@/lib/token/network-state";

import PortTokenLayout from "./port/token/PortTokenLayout";
import PortTokenSidebar from "./port/token/PortTokenSidebar";
import PortTokenWorkspace from "./port/token/PortTokenWorkspace";

type StudioTab = "create" | "send";

import type { AlphaNetHealth } from "@/components/port/useAlphaNetHealth";

interface TokenStudioProps {
  account: ThruAccount | null;
  onBusyChange?: (busy: boolean) => void;
  health?: AlphaNetHealth;
  portfolioHook: TokenPortfolioHook;
}

export default function TokenStudio({
  account,
  onBusyChange = () => {},
  health,
  portfolioHook,
}: TokenStudioProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>("send");
  const [selectedTokenMint, setSelectedTokenMint] = useState<string | null>(null);
  const [initialSelectDone, setInitialSelectDone] = useState(false);

  const networkActionsDisabled = tokenNetworkActionsDisabled(health?.status);
  const networkWarning = tokenNetworkWarning(health?.status);

  const ownedPortfolio = portfolioHook.portfolio;
  const savedRecords = portfolioHook.records.filter(
    (record) => record.walletAddress === account?.address,
  );

  // Handle default selection
  useEffect(() => {
    if (!initialSelectDone && !portfolioHook.refreshing && ownedPortfolio.length > 0) {
      setSelectedTokenMint(ownedPortfolio[0].mintAddress);
      setInitialSelectDone(true);
    }
  }, [ownedPortfolio, portfolioHook.refreshing, initialSelectDone]);

  // Ensure selection is valid
  useEffect(() => {
    if (selectedTokenMint && !portfolioHook.refreshing) {
      const exists = ownedPortfolio.some(p => p.mintAddress === selectedTokenMint);
      if (!exists) {
        if (ownedPortfolio.length > 0) {
          setSelectedTokenMint(ownedPortfolio[0].mintAddress);
          setActiveTab("send");
        } else {
          setSelectedTokenMint(null);
          setActiveTab("send");
        }
      }
    }
  }, [ownedPortfolio, selectedTokenMint, portfolioHook.refreshing]);


  function handleTokenCreated(result: CreateTokenResult) {
    portfolioHook.addKnownToken(
      result.mintAddress,
      result.tokenAccountAddress,
      result.name,
      {
        creatorAddress: result.mint.creator,
        mintAuthorityAddress: result.mint.mintAuthority,
        ticker: result.ticker,
        decimals: result.decimals,
      },
    );
    setSelectedTokenMint(result.mintAddress);
    setActiveTab("send");
  }

  const selectedToken = ownedPortfolio.find(p => p.mintAddress === selectedTokenMint) || null;

  return (
    <div className="pc-token-studio-root" style={{ minHeight: "100%" }}>
      {networkWarning && (
        <p
          className={
            health?.status === "Offline"
              ? "name-network-message name-network-offline pc-token-network-message"
              : "name-network-message pc-token-network-message"
          }
          role="status"
        >
          {networkWarning}
        </p>
      )}
      {portfolioHook.persistenceWarning && (
        <p className="name-network-message" role="status">
          {portfolioHook.persistenceWarning}
        </p>
      )}
      <PortTokenLayout
        sidebar={
          <PortTokenSidebar
            portfolio={ownedPortfolio}
            savedRecords={savedRecords}
            selectedToken={selectedTokenMint}
            onSelectToken={(mint) => {
              setSelectedTokenMint(mint);
              setActiveTab("send");
            }}
            onCreateNew={() => {
              if (networkActionsDisabled) return;
              setActiveTab("create");
            }}
            networkStatus={health?.status}
            loading={portfolioHook.refreshing}
            error={safeTokenReadError(portfolioHook.portfolioError)}
          />
        }
        workspace={
          <PortTokenWorkspace
            activeView={activeTab}
            selectedToken={selectedToken}
            account={account}
            portfolioHook={portfolioHook}
            onBusyChange={onBusyChange}
            onTokenCreated={handleTokenCreated}
            health={health}
          />
        }
      />
    </div>
  );
}
