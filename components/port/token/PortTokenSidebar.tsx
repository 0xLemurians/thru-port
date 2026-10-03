import { useState } from "react";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import {
  tokenDisplayLabels,
  type KnownTokenRecord,
} from "@/lib/token/portfolio";
import type { NetworkStatus } from "@/components/port/useNetworkHealth";
import {
  invokeTokenNetworkAction,
  tokenNetworkActionsDisabled,
} from "@/lib/token/network-state";

export interface TokenSidebarEntry {
  mintAddress: string;
  label: string;
  secondaryLabel?: string;
  tokenAccountAddresses: string[];
  liveValidated: boolean;
}

export function buildTokenSidebarEntries(
  portfolio: TokenPortfolioItem[],
  savedRecords: KnownTokenRecord[],
): TokenSidebarEntry[] {
  const portfolioByMint = new Map(
    portfolio.map((item) => [item.mintAddress, item]),
  );
  const entries = savedRecords.map((record) => {
    const live = portfolioByMint.get(record.mintAddress);
    const labels = tokenDisplayLabels(
      record.label ?? live?.label,
      live?.mint?.ticker ?? record.ticker,
    );
    return {
      mintAddress: record.mintAddress,
      label: labels.primary,
      secondaryLabel: labels.secondary,
      tokenAccountAddresses:
        live?.tokenAccounts.map((account) => account.address) ??
        record.tokenAccountAddresses,
      liveValidated: Boolean(live?.mint),
    };
  });
  const savedMints = new Set(entries.map((entry) => entry.mintAddress));
  for (const item of portfolio) {
    if (savedMints.has(item.mintAddress)) continue;
    const labels = tokenDisplayLabels(item.label, item.mint?.ticker);
    entries.push({
      mintAddress: item.mintAddress,
      label: labels.primary,
      secondaryLabel: labels.secondary,
      tokenAccountAddresses: item.tokenAccounts.map(
        (account) => account.address,
      ),
      liveValidated: Boolean(item.mint),
    });
  }
  return entries;
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
  );
  const createDisabled = tokenNetworkActionsDisabled(networkStatus);

  const filteredEntries = entries.filter((item) => {
    if (!search) return true;
    const lowerSearch = search.toLowerCase();
    return (
      item.label.toLowerCase().includes(lowerSearch) ||
      item.secondaryLabel?.toLowerCase().includes(lowerSearch) ||
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
          {loading && (
            <div className="pc-token-list-msg">
              {entries.length > 0 ? "Refreshing portfolio..." : "Loading portfolio..."}
            </div>
          )}
          {error && <div className="pc-token-list-msg error">{error}</div>}
          
          {!loading && entries.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              {networkStatus === "Offline"
                ? "Live token state is unavailable. No locally saved token references are available."
                : "No saved tokens yet."}
            </div>
          )}

          {entries.length > 0 && filteredEntries.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              No matches found.
            </div>
          )}

          {filteredEntries.map((item) => {
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
                {item.secondaryLabel && (
                  <div className="pc-token-list-item-address mono" style={{ marginTop: "4px" }}>
                    {item.secondaryLabel}
                  </div>
                )}
                {!item.liveValidated && (
                  <div className="pc-token-list-item-address" style={{ marginTop: "4px" }}>
                    {networkStatus === "Offline" || error
                      ? "Live state unavailable"
                      : "Saved locally · not confirmed live"}
                  </div>
                )}
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
