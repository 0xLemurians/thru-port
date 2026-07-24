import { useState } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import type { CreateTokenResult } from "@/lib/token/thru-token";
import TokenCreateForm from "@/components/token-studio/TokenCreateForm";
import TokenSendForm from "@/components/token-studio/TokenSendForm";
import TokenMintMoreForm from "@/components/token-studio/TokenMintMoreForm";
import TokenAdvancedTools from "@/components/token-studio/TokenAdvancedTools";
import type { AlphaNetHealth } from "@/components/port/useAlphaNetHealth";
import PortTokenOverview from "./PortTokenOverview";

interface PortTokenWorkspaceProps {
  activeView: string;
  selectedToken: TokenPortfolioItem | null;
  account: ThruAccount | null;
  portfolioHook: ReturnType<typeof import("@/lib/token/portfolio-hook").useTokenPortfolio>;
  onBusyChange: (busy: boolean) => void;
  onTokenCreated?: (result: CreateTokenResult) => void;
  onCreateNew?: () => void;
  health?: AlphaNetHealth;
}

export default function PortTokenWorkspace({
  activeView,
  selectedToken,
  account,
  portfolioHook,
  onBusyChange,
  onTokenCreated = () => {},
  onCreateNew = () => {},
  health,
}: PortTokenWorkspaceProps) {
  const [manualLabel, setManualLabel] = useState("");
  const [manualMint, setManualMint] = useState("");
  const [manualTokenAccount, setManualTokenAccount] = useState("");

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualMint) {
      portfolioHook.addKnownToken(manualMint, manualTokenAccount, manualLabel);
      setManualLabel("");
      setManualMint("");
      setManualTokenAccount("");
    }
  };

  return (
    <div className="pc-token-workspace-inner">
      {activeView === "overview" && (
        <PortTokenOverview
          selectedToken={selectedToken}
          removeKnownToken={portfolioHook.removeKnownToken}
          onCreateNew={onCreateNew}
        />
      )}

      {activeView === "create" && (
        <TokenCreateForm
          account={account}
          onBusyChange={onBusyChange}
          onSuccess={onTokenCreated}
        />
      )}

      {activeView === "send" && (
        <TokenSendForm
          account={account}
          portfolio={portfolioHook.portfolio}
          onBusyChange={onBusyChange}
          selectedTokenMint={selectedToken?.mintAddress}
          health={health}
          onSuccess={() => portfolioHook.refreshRecords(portfolioHook.records)}
        />
      )}

      {activeView === "mint-more" && (
        <TokenMintMoreForm
          account={account}
          portfolio={portfolioHook.portfolio}
          onBusyChange={onBusyChange}
          onSuccess={() => portfolioHook.refreshRecords(portfolioHook.records)}
          selectedTokenMint={selectedToken?.mintAddress}
        />
      )}

      {activeView === "advanced" && (
        <div className="pc-token-advanced-wrapper">
          <TokenAdvancedTools
            account={account}
            portfolio={portfolioHook.portfolio}
            onBusyChange={onBusyChange}
          />
          <form className="pc-token-track-form" onSubmit={handleAdd}>
            <h4>Manually track a token</h4>
            <div className="form-field-group">
              <label className="form-field">
                <span className="field-label">Label (optional)</span>
                <input
                  className="input"
                  value={manualLabel}
                  onChange={(e) => setManualLabel(e.target.value)}
                  placeholder="Treasury token"
                />
              </label>
              <label className="form-field">
                <span className="field-label">Mint address</span>
                <input
                  className="input mono"
                  value={manualMint}
                  onChange={(e) => setManualMint(e.target.value)}
                  placeholder="ta..."
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
              </label>
              <label className="form-field">
                <span className="field-label">Token account (optional)</span>
                <input
                  className="input mono"
                  value={manualTokenAccount}
                  onChange={(e) => setManualTokenAccount(e.target.value)}
                  placeholder="ta..."
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button className="pc-btn-primary" type="submit">
                Track Token
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
