import { useState } from "react";
import { formatRawAmount } from "@thru/programs/token";
import { explorerAddressUrl } from "@/lib/wallet/thru-wallet";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";

export default function PortfolioCard({
  item,
  accountAddress,
  onRemove,
}: {
  item: TokenPortfolioItem;
  accountAddress?: string;
  onRemove: (mintAddress: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  // Simple view calculations
  const activeTokenAccounts = accountAddress
    ? item.tokenAccounts.filter((acc) => acc.state?.owner === accountAddress)
    : [];

  const totalActiveBalanceRaw = activeTokenAccounts.reduce(
    (sum, acc) => sum + (acc.state?.amount ?? 0n),
    0n,
  );

  return (
    <article className="portfolio-card">
      <div className="portfolio-card-header">
        <div>
          <h3>{item.label || item.mint?.ticker || "Known token"}</h3>
          <code className="mono">{shortAddress(item.mintAddress)}</code>
        </div>
        <div className="portfolio-card-actions">
          <a
            className="icon-btn"
            href={explorerAddressUrl(item.mintAddress)}
            target="_blank"
            rel="noreferrer"
            aria-label="View mint on Explorer"
          >
            ↗
          </a>
          <button
            className="btn btn-ghost"
            onClick={() => onRemove(item.mintAddress)}
            title="Remove from saved list"
          >
            Remove
          </button>
        </div>
      </div>

      {item.error ? (
        <p className="error token-error">{item.error}</p>
      ) : item.mint ? (
        <dl className="portfolio-details">
          <div>
            <dt>Ticker</dt>
            <dd className="mono">{item.mint.ticker}</dd>
          </div>
          <div>
            <dt>Supply</dt>
            <dd>
              {formatRawAmount(item.mint.supply, item.mint.decimals)}
            </dd>
          </div>
          {accountAddress && (
            <div>
              <dt>Your Balance</dt>
              <dd>
                {formatRawAmount(totalActiveBalanceRaw, item.mint.decimals)}
              </dd>
            </div>
          )}
        </dl>
      ) : null}

      <div className="portfolio-details-toggle">
        <button
          className="btn btn-link"
          onClick={() => setShowDetails((prev) => !prev)}
        >
          {showDetails ? "Hide Details" : "Show Details"}
        </button>
      </div>

      {showDetails && (
        <div className="portfolio-details-expanded">
          {item.mint && (
            <dl className="portfolio-details">
              <div>
                <dt>Full Mint Address</dt>
                <dd className="mono">{item.mintAddress}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{item.mint.decimals}</dd>
              </div>
              <div className="portfolio-detail-wide">
                <dt>Mint Authority</dt>
                <dd className="mono">{item.mint.mintAuthority}</dd>
              </div>
              <div>
                <dt>Freeze Authority</dt>
                <dd>
                  {item.mint.hasFreezeAuthority
                    ? item.mint.freezeAuthority
                    : "None"}
                </dd>
              </div>
              <div>
                <dt>Raw Supply</dt>
                <dd>{item.mint.supply.toString()}</dd>
              </div>
            </dl>
          )}

          <div className="portfolio-accounts">
            <h4>Known token accounts</h4>
            {item.tokenAccounts.length === 0 ? (
              <p className="hint">No token account address has been added.</p>
            ) : (
              item.tokenAccounts.map((entry) => (
                <div className="portfolio-account" key={entry.address}>
                  <div className="portfolio-account-header">
                    <code className="mono">{entry.address}</code>
                    <a
                      className="icon-btn"
                      href={explorerAddressUrl(entry.address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ↗
                    </a>
                  </div>
                  {entry.error && <p className="error">{entry.error}</p>}
                  {entry.state && (
                    <dl className="portfolio-account-details">
                      <div>
                        <dt>Balance</dt>
                        <dd>
                          {item.mint
                            ? formatRawAmount(
                                entry.state.amount,
                                item.mint.decimals,
                              )
                            : entry.state.amount.toString()}
                        </dd>
                      </div>
                      <div>
                        <dt>Raw Balance</dt>
                        <dd>{entry.state.amount.toString()}</dd>
                      </div>
                      <div>
                        <dt>Frozen</dt>
                        <dd>{entry.state.isFrozen ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd className="mono">{entry.state.owner}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}
