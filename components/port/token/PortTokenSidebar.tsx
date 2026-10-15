import React, { useState } from "react";
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
import type { WalletPortfolio } from "@/lib/portfolio/asset-model";
import { assetLabel, portfolioGroups } from "@/lib/portfolio/presentation";
import { TokenAssetSummary } from "@/components/command/PortfolioAssets";

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
      liveValidated: Boolean(live?.mint) && live?.discoveryRead !== "cached",
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
      liveValidated: Boolean(item.mint) && item.discoveryRead !== "cached",
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
  walletAddress?: string;
  portfolioModel?: WalletPortfolio | null;
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
  walletAddress,
  portfolioModel,
}: PortTokenSidebarProps) {
  const [search, setSearch] = useState("");
  const entries = portfolioModel ? portfolioModel.tokens.map((asset) => ({
    mintAddress: asset.mintAddress, label: assetLabel(asset), secondaryLabel: asset.metadata.ticker?.value,
    tokenAccountAddresses: asset.sources.map((source) => source.address), liveValidated: asset.observation.source === "rpc",
  })) : buildTokenSidebarEntries(
    portfolio,
    savedRecords,
  );
  const createDisabled = tokenNetworkActionsDisabled(networkStatus);
  const holds = (mint: string) => Boolean(walletAddress) && portfolio.some((item) => item.mintAddress === mint &&
    item.tokenAccounts.some((account) => account.state?.owner === walletAddress && account.state?.mint === mint));
  const controls = (mint: string) => Boolean(walletAddress) && portfolio.some((item) => item.mintAddress === mint &&
    (item.mint?.creator === walletAddress || item.mint?.mintAuthority === walletAddress));

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

  const groups = portfolioModel ? portfolioGroups(portfolioModel.tokens).map((group) => ({ title: group.title,
    entries: filteredEntries.filter((entry) => group.assets.some((asset) => asset.mintAddress === entry.mintAddress)) })) :
    [{ title: "My Holdings", entries: filteredEntries.filter((item) => holds(item.mintAddress)) },
      { title: "Created / Controlled Tokens", entries: filteredEntries.filter((item) => !holds(item.mintAddress) && controls(item.mintAddress)) },
      { title: "Saved References", entries: filteredEntries.filter((item) => !holds(item.mintAddress) && !controls(item.mintAddress)) }];

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
            aria-label="Search tokens by label, mint or account"
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
                : "No holdings or saved references in this snapshot. Discovery may be incomplete."}
            </div>
          )}

          {entries.length > 0 && filteredEntries.length === 0 && (
            <div className="pc-token-list-msg empty-state">
              No matches found.
            </div>
          )}

          {groups.map((group) => <section key={group.title} aria-label={group.title}>
            <h3 style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "12px 0 6px" }}>{group.title}</h3>
          {group.entries.map((item) => {
            const isSelected = selectedToken === item.mintAddress;
            const asset = portfolioModel?.tokens.find((asset) => asset.mintAddress === item.mintAddress);
            return (
              <button
                type="button"
                key={item.mintAddress}
                aria-pressed={isSelected}
                className={`pc-token-list-item ${isSelected ? "active" : ""}`}
                onClick={() => onSelectToken(item.mintAddress)}
              >
                {asset ? <TokenAssetSummary asset={asset} /> : <>
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
                {portfolio.some((live) => live.mintAddress === item.mintAddress &&
                  (live.mint?.creator === walletAddress || live.mint?.mintAuthority === walletAddress)) &&
                  <div className="pc-token-list-item-address">Created / controlled by this wallet{item.liveValidated ? "" : " · cached"}</div>}
                </>}
              </button>
            );
          })}
          </section>)}
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
