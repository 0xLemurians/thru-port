import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import { formatRawAmount } from "@thru/programs/token";

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

interface PortTokenOverviewProps {
  selectedToken: TokenPortfolioItem | null;
  removeKnownToken: (mint: string) => void;
  onCreateNew: () => void;
}

export default function PortTokenOverview({
  selectedToken,
  removeKnownToken,
  onCreateNew,
}: PortTokenOverviewProps) {
  if (!selectedToken) {
    return (
      <div className="pc-token-overview-empty">
        <div className="pc-token-overview-empty-msg">
          <h2>No Token Selected</h2>
          <p>Select a token from the sidebar or create a new one.</p>
          <button className="pc-btn-primary" onClick={onCreateNew} style={{ marginTop: "24px" }}>
            Create Token
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-token-overview">
      <div className="pc-token-overview-header">
        <h2>{selectedToken.label || "Unnamed Token"}</h2>
        <button
          className="pc-btn-secondary pc-btn-sm"
          onClick={() => removeKnownToken(selectedToken.mintAddress)}
        >
          Remove from portfolio
        </button>
      </div>

      <div className="pc-token-overview-details">
        <div className="detail-row">
          <span className="key">Label</span>
          <span className="val">{selectedToken.label || "—"}</span>
        </div>
        <div className="detail-row">
          <span className="key">Mint Address</span>
          <span className="val mono">{selectedToken.mintAddress}</span>
        </div>
        <div className="detail-row">
          <span className="key">Token Account</span>
          <span className="val mono">{selectedToken.tokenAccounts?.[0]?.address || "—"}</span>
        </div>
        <div className="detail-row">
          <span className="key">Balance</span>
          <span className="val">
            {selectedToken.tokenAccounts[0]?.state?.amount !== undefined && selectedToken.mint?.decimals !== undefined
              ? `${formatRawAmount(selectedToken.tokenAccounts[0].state.amount, selectedToken.mint.decimals)} ${selectedToken.mint?.ticker ?? selectedToken.label ?? ""}`.trim()
              : "—"}
          </span>
        </div>
        <div className="detail-row">
          <span className="key">Supply</span>
          <span className="val">
            {selectedToken.mint?.supply !== undefined && selectedToken.mint?.decimals !== undefined
              ? `${formatRawAmount(selectedToken.mint.supply, selectedToken.mint.decimals)} ${selectedToken.mint?.ticker ?? selectedToken.label ?? ""}`.trim()
              : "—"}
          </span>
        </div>
        <div className="detail-row">
          <span className="key">Decimals</span>
          <span className="val">{selectedToken.mint?.decimals ?? "—"}</span>
        </div>
        <div className="detail-row">
          <span className="key">Authority</span>
          <span className="val mono" title={selectedToken.mint?.mintAuthority}>
            {selectedToken.mint?.mintAuthority ? shortAddress(selectedToken.mint.mintAuthority) : "—"}
          </span>
        </div>
      </div>

      <p className="hint" style={{ marginTop: "24px" }}>
        Note: The resume partial setup flow is available in the Advanced Tools view if applicable.
      </p>
    </div>
  );
}
