"use client";

import { useState, useEffect } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { useTokenPortfolio } from "@/lib/token/portfolio-hook";
import type { CreateTokenResult } from "@/lib/token/thru-token";

import PortTokenLayout from "./port/token/PortTokenLayout";
import PortTokenSidebar from "./port/token/PortTokenSidebar";
import PortTokenWorkspace from "./port/token/PortTokenWorkspace";
import PortTokenQuickActions from "./port/token/PortTokenQuickActions";

type StudioTab = "overview" | "create" | "send" | "mint-more" | "advanced";

interface TokenStudioProps {
  account: ThruAccount | null;
  onBusyChange?: (busy: boolean) => void;
  // health from AppFlow might be useful if we want to pass isOffline,
  // but for now, we'll pass false or check if we can get it.
  // The user said "Mevcut AppFlow health state’i prop zincirinde zaten erişilebiliyorsa yalnızca küçük bir status notice gösterilebilir. Health prop’u Token Studio sınırında mevcut değilse bu aşamada AppFlow’u değiştirme."
}

export default function TokenStudio({
  account,
  onBusyChange = () => {},
}: TokenStudioProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>("overview");
  const [selectedTokenMint, setSelectedTokenMint] = useState<string | null>(null);
  const [initialSelectDone, setInitialSelectDone] = useState(false);

  // Lift portfolio state to TokenStudio so it can be shared across tabs.
  const portfolioHook = useTokenPortfolio(account);

  // Handle default selection
  useEffect(() => {
    if (!initialSelectDone && !portfolioHook.refreshing && portfolioHook.portfolio.length > 0) {
      setSelectedTokenMint(portfolioHook.portfolio[0].mintAddress);
      setInitialSelectDone(true);
    }
  }, [portfolioHook.portfolio, portfolioHook.refreshing, initialSelectDone]);

  // Ensure selection is valid
  useEffect(() => {
    if (selectedTokenMint && !portfolioHook.refreshing) {
      const exists = portfolioHook.portfolio.some(p => p.mintAddress === selectedTokenMint);
      if (!exists) {
        if (portfolioHook.portfolio.length > 0) {
          setSelectedTokenMint(portfolioHook.portfolio[0].mintAddress);
          setActiveTab("overview");
        } else {
          setSelectedTokenMint(null);
          setActiveTab("overview");
        }
      }
    }
  }, [portfolioHook.portfolio, selectedTokenMint, portfolioHook.refreshing]);


  function handleTokenCreated(result: CreateTokenResult) {
    portfolioHook.addKnownToken(result.mintAddress, result.tokenAccountAddress, result.name);
    // Optionally auto-select the new token:
    setSelectedTokenMint(result.mintAddress);
    setActiveTab("overview");
  }

  const selectedToken = portfolioHook.portfolio.find(p => p.mintAddress === selectedTokenMint) || null;

  return (
    <div className="pc-token-studio-root">
      <PortTokenLayout
        sidebar={
          <PortTokenSidebar
            portfolio={portfolioHook.portfolio}
            selectedToken={selectedTokenMint}
            onSelectToken={(mint) => {
              setSelectedTokenMint(mint);
              setActiveTab("overview");
            }}
            onCreateNew={() => {
              setActiveTab("create");
            }}
            onAdvanced={() => {
              setActiveTab("advanced");
            }}
            loading={portfolioHook.refreshing}
            error={portfolioHook.portfolioError}
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
            onCreateNew={() => setActiveTab("create")}
          />
        }
        quickActions={
          <PortTokenQuickActions
            selectedToken={selectedToken}
            activeView={activeTab}
            onAction={(view) => setActiveTab(view)}
            isOffline={false} // Phase 3A: No health prop passed yet
          />
        }
      />
    </div>
  );
}
