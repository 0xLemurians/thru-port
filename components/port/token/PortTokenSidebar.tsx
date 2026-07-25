import { useState } from "react";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import type { KnownTokenRecord } from "@/lib/token/portfolio";
import type { NetworkStatus } from "@/components/port/useAlphaNetHealth";
import {
  invokeTokenNetworkAction,
  tokenNetworkActionsDisabled,
} from "@/lib/token/network-state";

export interface TokenSidebarEntry {
  mintAddress: string;
  label: string;
  secondaryLabel: string;
  tokenAccountAddresses: string[];
}

export function buildTokenSidebarEntries(
  portfolio: TokenPortfolioItem[],
  savedRecords: KnownTokenRecord[],
  networkStatus: NetworkStatus | undefined,
): TokenSidebarEntry[] {
  const portfolioByMint = new Map(
    portfolio.map((item) => [item.mintAddress, item]),
  );

  if (networkStatus === "Offline") {
    return savedRecords.map((record) => {
      const cached = portfolioByMint.get(record.mintAddress);
      return {
        mintAddress: record.mintAddress,
        label:
          cached?.mint?.ticker ??
          cached?.label ??
          record.label ??
          "Saved token",
        secondaryLabel: cached?.mint?.ticker ?? "Saved locally",
        tokenAccountAddresses:
          cached?.tokenAccounts.map((account) => account.address) ??
          record.tokenAccountAddresses,
      };
    });
  }

  return portfolio.map((item) => ({
    mintAddress: item.mintAddress,
    label: item.mint?.ticker ?? item.label ?? "Unnamed Token",
    secondaryLabel: item.mint?.ticker ?? "TOKEN",
    tokenAccountAddresses: item.tokenAccounts.map((account) => account.address),
  }));
}

interface PortTokenSidebarProps {
  portfolio: TokenPortfolioItem[];
  savedRecords: KnownTokenRecord[];
  selectedToken: string | null;
  onSelectToken: (mintAddress: string) => void;
  onCreateNew: () => void;
  networkStatus?: NetworkStatus;
  loading: boolean;
  error: string | null;
}

export default function PortTokenSidebar({
  portfolio,
  savedRecords,
  selectedToken,
  onSelectToken,
  onCreateNew,
  networkStatus,
  loading,
  error,
}: PortTokenSidebarProps) {
  const [search, setSearch] = useState("");
  const entries = buildTokenSidebarEntries(
    portfolio,
    savedRecords,
    networkStatus,
  );
  const createDisabled = tokenNetworkActionsDisabled(networkStatus);

  const filteredEntries = entries.filter((item) => {
    if (!search) return true;
    const lowerSearch = search.toLowerCase();
    return (
      item.label.toLowerCase().includes(lowerSearch) ||
      item.mintAddress.toLowerCase().includes(lowerSearch) ||
      item.tokenAccountAddresses.some((address) =>
        address.toLowerCase().includes(lowerSearch),
      )
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
          
          {!loading && !error && entries.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              {networkStatus === "Offline"
                ? "Live token state is unavailable. No locally saved token references are available."
                : "No saved tokens yet."}
            </div>
          )}

          {!loading && !error && entries.length > 0 && filteredEntries.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              No matches found.
            </div>
          )}

          {!loading && !error && filteredEntries.map((item) => {
            const isSelected = selectedToken === item.mintAddress;
            return (
              <button
                key={item.mintAddress}
                className={`pc-token-list-item ${isSelected ? "active" : ""}`}
                onClick={() => onSelectToken(item.mintAddress)}
              >
                <div className="pc-token-list-item-label" style={{ fontWeight: 600 }}>
                  {item.label}
                </div>
                <div className="pc-token-list-item-address mono" style={{ marginTop: "4px" }}>
                  {item.secondaryLabel}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pc-token-sidebar-bottom">
        <button 
          className="pc-btn-primary pc-btn-block token-network-action"
          onClick={() => {
            invokeTokenNetworkAction(onCreateNew, networkStatus);
          }}
          disabled={createDisabled}
          style={{ width: "100%", display: "block", boxSizing: "border-box", marginBottom: "12px" }}
        >
          Create New
        </button>
      </div>
    </div>
  );
}
