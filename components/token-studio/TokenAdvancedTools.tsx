import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import ResumeTokenSetup from "@/components/ResumeTokenSetup";
import CreateDestinationTokenAccount from "@/components/CreateDestinationTokenAccount";

export default function TokenAdvancedTools({
  account,
  portfolio,
  onBusyChange,
}: {
  account: ThruAccount | null;
  portfolio: TokenPortfolioItem[];
  onBusyChange: (busy: boolean) => void;
}) {
  if (!account) {
    return (
      <div className="panel">
        <p>Create or import a wallet to use this action.</p>
      </div>
    );
  }

  return (
    <div className="token-section">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Advanced</p>
          <h3>Technical tools</h3>
        </div>
      </div>
      <p className="hint">
        These tools are used to recover incomplete token creations or manually
        provision deterministic token accounts. They are rarely needed for regular usage.
      </p>

      <div style={{ marginTop: "2rem" }}>
        <details>
          <summary>Resume token setup</summary>
          <div style={{ marginTop: "1rem" }}>
            <ResumeTokenSetup
              account={account}
              portfolio={portfolio}
              disabled={false}
              onBusyChange={onBusyChange}
              onCompleted={() => {}}
            />
          </div>
        </details>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <details>
          <summary>Create destination token account</summary>
          <div style={{ marginTop: "1rem" }}>
            <CreateDestinationTokenAccount
              account={account}
              portfolio={portfolio}
              disabled={false}
              onBusyChange={onBusyChange}
              onCompleted={() => {}}
            />
          </div>
        </details>
      </div>
    </div>
  );
}
