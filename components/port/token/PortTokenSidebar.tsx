import { useState } from "react";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";

interface PortTokenSidebarProps {
  portfolio: TokenPortfolioItem[];
  selectedToken: string | null;
  onSelectToken: (mintAddress: string) => void;
  onCreateNew: () => void;
  onAdvanced: () => void;
  loading: boolean;
  error: string | null;
}

export default function PortTokenSidebar({
  portfolio,
  selectedToken,
  onSelectToken,
  onCreateNew,
  onAdvanced,
  loading,
  error,
}: PortTokenSidebarProps) {
  const [search, setSearch] = useState("");

  const filteredPortfolio = portfolio.filter((item) => {
    if (!search) return true;
    const lowerSearch = search.toLowerCase();
    return (
      (item.label || "").toLowerCase().includes(lowerSearch) ||
      item.mintAddress.toLowerCase().includes(lowerSearch) ||
      item.tokenAccounts?.some(acc => acc.address.toLowerCase().includes(lowerSearch))
    );
  });

  return (
    <div className="pc-token-sidebar-inner">
      <div className="pc-token-sidebar-top">
        <div className="pc-token-sidebar-header">
          <h2>My Tokens</h2>
        </div>

        <div className="pc-token-search">
          <input
            type="text"
            className="pc-input"
            placeholder="Search tokens..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="pc-token-list">
          {loading && <div className="pc-token-list-msg">Loading portfolio...</div>}
          {error && <div className="pc-token-list-msg error">{error}</div>}
          
          {!loading && !error && portfolio.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              No saved tokens yet.
            </div>
          )}

          {!loading && !error && portfolio.length > 0 && filteredPortfolio.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              No matches found.
            </div>
          )}

          {!loading && !error && filteredPortfolio.map((item) => {
            const isSelected = selectedToken === item.mintAddress;
            return (
              <button
                key={item.mintAddress}
                className={`pc-token-list-item ${isSelected ? "active" : ""}`}
                onClick={() => onSelectToken(item.mintAddress)}
              >
                <div className="pc-token-list-item-label">
                  {item.label || "Unnamed Token"}
                </div>
                <div className="pc-token-list-item-address mono">
                  Mint: {item.mintAddress.slice(0, 8)}...
                </div>
                {item.tokenAccounts?.[0]?.address && (
                  <div className="pc-token-list-item-address mono">
                    Account: {item.tokenAccounts[0].address.slice(0, 8)}...
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="pc-token-sidebar-bottom">
        <button 
          className="pc-btn-primary pc-btn-block" 
          onClick={onCreateNew}
          style={{ width: "100%", display: "block", boxSizing: "border-box", marginBottom: "12px" }}
        >
          Create New
        </button>
        <button
          className="pc-btn-secondary pc-btn-block"
          onClick={onAdvanced}
          style={{ width: "100%", display: "block", boxSizing: "border-box", border: "none", background: "transparent", color: "var(--text-dim)" }}
        >
          Advanced
        </button>
      </div>
    </div>
  );
}
