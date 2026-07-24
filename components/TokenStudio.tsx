"use client";

import { useState } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { useTokenPortfolio } from "@/lib/token/portfolio-hook";
import TokenPortfolioOverview from "./token-studio/TokenPortfolioOverview";
import TokenCreateForm from "./token-studio/TokenCreateForm";
import TokenSendForm from "./token-studio/TokenSendForm";
import TokenMintMoreForm from "./token-studio/TokenMintMoreForm";
import TokenAdvancedTools from "./token-studio/TokenAdvancedTools";
import type { CreateTokenResult } from "@/lib/token/thru-token";

type StudioTab = "overview" | "create" | "send" | "mint-more" | "advanced";

interface TokenStudioProps {
  account: ThruAccount | null;
  onBusyChange?: (busy: boolean) => void;
}

export default function TokenStudio({
  account,
  onBusyChange = () => {},
}: TokenStudioProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>("overview");

  // Lift portfolio state to TokenStudio so it can be shared across tabs.
  const portfolioHook = useTokenPortfolio(account);

  function handleTokenCreated(result: CreateTokenResult) {
    portfolioHook.addKnownToken(result.mintAddress, result.tokenAccountAddress, result.name);
  }

  return (
    <div className="panel token-studio">
      <nav className="token-studio-nav" aria-label="Token Studio tabs">
        <button
          type="button"
          className={activeTab === "overview" ? "active" : ""}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={activeTab === "create" ? "active" : ""}
          onClick={() => setActiveTab("create")}
        >
          Create Token
        </button>
        <button
          type="button"
          className={activeTab === "send" ? "active" : ""}
          onClick={() => setActiveTab("send")}
        >
          Send
        </button>
        <button
          type="button"
          className={activeTab === "mint-more" ? "active" : ""}
          onClick={() => setActiveTab("mint-more")}
        >
          Mint More
        </button>
        <button
          type="button"
          className={activeTab === "advanced" ? "active" : ""}
          onClick={() => setActiveTab("advanced")}
        >
          Advanced
        </button>
      </nav>

      <div className="token-studio-content">
        {activeTab === "overview" && (
          <TokenPortfolioOverview
            account={account}
            portfolioHook={portfolioHook}
            onBusyChange={onBusyChange}
          />
        )}

        {activeTab === "create" && (
          <TokenCreateForm
            account={account}
            onBusyChange={onBusyChange}
            onSuccess={handleTokenCreated}
          />
        )}

        {activeTab === "send" && (
          <TokenSendForm
            account={account}
            portfolio={portfolioHook.portfolio}
            onBusyChange={onBusyChange}
          />
        )}

        {activeTab === "mint-more" && (
          <TokenMintMoreForm
            account={account}
            portfolio={portfolioHook.portfolio}
            onBusyChange={onBusyChange}
          />
        )}

        {activeTab === "advanced" && (
          <TokenAdvancedTools
            account={account}
            portfolio={portfolioHook.portfolio}
            onBusyChange={onBusyChange}
          />
        )}
      </div>
    </div>
  );
}
