import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import type { CreateTokenResult } from "@/lib/token/thru-token";
import TokenCreateForm from "@/components/token-studio/TokenCreateForm";
import TokenSendForm from "@/components/token-studio/TokenSendForm";
import type { NetworkHealth } from "@/components/port/useNetworkHealth";
import type { TokenAsset } from "@/lib/portfolio/asset-model";
import { TokenAccountDetails, TokenAssetSummary } from "@/components/command/PortfolioAssets";

interface PortTokenWorkspaceProps {
  activeView: string;
  selectedToken: TokenPortfolioItem | null;
  account: ThruAccount | null;
  portfolioHook: import("@/lib/token/portfolio-hook").TokenPortfolioHook;
  onBusyChange: (busy: boolean) => void;
  onTokenCreated?: (result: CreateTokenResult) => void;
  health?: NetworkHealth;
  selectedAsset?: TokenAsset;
  portfolioItems?: TokenPortfolioItem[];
}

export default function PortTokenWorkspace({
  activeView,
  selectedToken,
  account,
  portfolioHook,
  onBusyChange,
  onTokenCreated = () => {},
  health,
  selectedAsset,
  portfolioItems,
}: PortTokenWorkspaceProps) {
  return (
    <div className="pc-token-workspace-inner">
      {activeView === "create" && (
        <TokenCreateForm
          account={account}
          onBusyChange={onBusyChange}
          onSuccess={onTokenCreated}
          networkStatus={health?.status}
        />
      )}

      {activeView === "send" && (
        <>
        {selectedAsset && <section aria-label="Selected token details" className="pc-token-section">
          <TokenAssetSummary asset={selectedAsset} />
          <TokenAccountDetails asset={selectedAsset} />
        </section>}
        <TokenSendForm
          account={account}
          portfolio={portfolioItems ?? portfolioHook.portfolio}
          onBusyChange={onBusyChange}
          selectedTokenMint={selectedToken?.mintAddress}
          health={health}
          onSuccess={() => portfolioHook.refreshRecords(portfolioHook.records)}
        />
        </>
      )}
    </div>
  );
}
