import { useState } from "react";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

interface PortTokenQuickActionsProps {
  selectedToken: TokenPortfolioItem | null;
  activeView: string;
  onAction: (view: "send" | "mint-more") => void;
  isOffline: boolean;
  account?: ThruAccount | null;
}

export default function PortTokenQuickActions({
  selectedToken,
  activeView,
  onAction,
  isOffline,
  account,
}: PortTokenQuickActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!selectedToken) return;
    try {
      await navigator.clipboard.writeText(selectedToken.mintAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // safe silent fallback
    }
  };

  const isDisabled = !selectedToken || isOffline;

  return (
    <div className="pc-token-qa-inner">
      <div className="pc-token-qa-header">
        <div className="copper-line" />
        <h3>QUICK ACTIONS</h3>
      </div>

      <div className="pc-token-qa-actions">
        <button
          className={`pc-btn-secondary pc-btn-block ${activeView === "send" ? "active" : ""}`}
          onClick={() => onAction("send")}
          disabled={isDisabled}
        >
          Transfer Tokens
        </button>
        <button
          className={`pc-btn-secondary pc-btn-block ${activeView === "mint-more" ? "active" : ""}`}
          onClick={() => onAction("mint-more")}
          disabled={isDisabled}
        >
          Mint More
        </button>
        <button
          className="pc-btn-secondary pc-btn-block"
          onClick={handleCopy}
          disabled={!selectedToken}
        >
          {copied ? "Copied!" : "Copy Mint Address"}
        </button>
      </div>

      <div className="pc-token-qa-info">
        <div className="pc-token-qa-info-row">
          <span className="key">Network</span>
          <span className="val">AlphaNet</span>
        </div>
        <div className="pc-token-qa-info-row">
          <span className="key">Authority</span>
          <span className="val mono" title={selectedToken?.mint?.mintAuthority}>
            {!selectedToken
              ? "Unknown"
              : selectedToken.mint?.mintAuthority === account?.address
              ? "Current wallet"
              : selectedToken.mint?.mintAuthority
              ? shortAddress(selectedToken.mint.mintAuthority)
              : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
