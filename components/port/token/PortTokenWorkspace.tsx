import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import type { CreateTokenResult } from "@/lib/token/thru-token";
import TokenCreateForm from "@/components/token-studio/TokenCreateForm";
import TokenSendForm from "@/components/token-studio/TokenSendForm";
import type { AlphaNetHealth } from "@/components/port/useAlphaNetHealth";

interface PortTokenWorkspaceProps {
  activeView: string;
  selectedToken: TokenPortfolioItem | null;
  account: ThruAccount | null;
  portfolioHook: ReturnType<typeof import("@/lib/token/portfolio-hook").useTokenPortfolio>;
  onBusyChange: (busy: boolean) => void;
  onTokenCreated?: (result: CreateTokenResult) => void;
  health?: AlphaNetHealth;
}

export default function PortTokenWorkspace({
  activeView,
  selectedToken,
  account,
  portfolioHook,
  onBusyChange,
  onTokenCreated = () => {},
  health,
}: PortTokenWorkspaceProps) {
  return (
    <div className="pc-token-workspace-inner">
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
    </div>
  );
}
