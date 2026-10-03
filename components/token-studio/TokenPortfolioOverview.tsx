import { useState } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { THRU_NETWORK } from "@/lib/thru/network";
import { classifyPortfolio } from "@/lib/token/portfolio";
import PortfolioCard from "./PortfolioCard";

export default function TokenPortfolioOverview({
  account,
  portfolioHook,
}: {
  account: ThruAccount | null;
  portfolioHook: ReturnType<typeof import("@/lib/token/portfolio-hook").useTokenPortfolio>;
  onBusyChange: (busy: boolean) => void;
}) {
  const {
    portfolio,
    records,
    refreshing,
    portfolioError,
    refreshRecords,
    addKnownToken,
    removeKnownToken,
    clearExternalAssets,
  } = portfolioHook;

  const [manualLabel, setManualLabel] = useState("");
  const [manualMint, setManualMint] = useState("");
  const [manualTokenAccount, setManualTokenAccount] = useState("");

  function handleAddKnownToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      addKnownToken(manualMint, manualTokenAccount, manualLabel);
      setManualLabel("");
      setManualMint("");
      setManualTokenAccount("");
    } catch {
      // The hook doesn't currently return error from upsert directly, but upsert throws
      // We could add local error state for the form if needed.
    }
  }

  const { activeAssets, externalAssets } = classifyPortfolio(portfolio, account?.address);

  return (
    <section className="token-section" aria-labelledby="token-portfolio-title">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Overview</p>
          <h3 id="token-portfolio-title">
            {account ? "Active wallet assets" : `Saved public ${THRU_NETWORK.displayName} assets on this browser`}
          </h3>
        </div>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={refreshing}
          onClick={() => void refreshRecords(records)}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <p className="hint">
        Only public mint and token-account addresses are saved locally. Secret
        keys and recovery phrases are never stored.
      </p>

      {portfolioError && <p className="error token-error">{portfolioError}</p>}

      {account && activeAssets.length > 0 && (
        <div className="portfolio-list">
          {activeAssets.map((item) => (
            <PortfolioCard
              key={item.mintAddress}
              item={item}
              accountAddress={account.address}
              onRemove={removeKnownToken}
            />
          ))}
        </div>
      )}

      {(!account || activeAssets.length === 0) && externalAssets.length === 0 && !refreshing && (
        <div className="portfolio-empty">
          No saved public {THRU_NETWORK.displayName} assets on this browser.
        </div>
      )}

      {(externalAssets.length > 0 || (!account && activeAssets.length > 0)) && (
        <details className="external-assets-details" open={!account}>
          <summary>
            {account ? `Saved external assets (${externalAssets.length})` : "Saved public assets"}
          </summary>
          <div className="portfolio-list" style={{ marginTop: "1rem" }}>
            {externalAssets.map((item) => (
              <PortfolioCard
                key={item.mintAddress}
                item={item}
                accountAddress={account?.address}
                onRemove={removeKnownToken}
              />
            ))}
            {!account && activeAssets.map((item) => (
              <PortfolioCard
                key={item.mintAddress}
                item={item}
                onRemove={removeKnownToken}
              />
            ))}
          </div>
          <div style={{ marginTop: "1rem" }}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => clearExternalAssets(account?.address)}
            >
              Clear saved external assets
            </button>
          </div>
        </details>
      )}

      <form className="portfolio-add-form" onSubmit={handleAddKnownToken} style={{ marginTop: "2rem" }}>
        <h4>Manually track a token</h4>
        <div className="form-field-group">
          <label className="form-field">
            <span className="field-label">Studio label (optional)</span>
            <input
              className="input"
              value={manualLabel}
              onChange={(event) => setManualLabel(event.target.value)}
              placeholder="Treasury token"
            />
          </label>
          <label className="form-field">
            <span className="field-label">Mint address</span>
            <input
              className="input mono"
              value={manualMint}
              onChange={(event) => setManualMint(event.target.value)}
              placeholder="ta..."
              spellCheck={false}
              autoComplete="off"
              required
            />
          </label>
          <label className="form-field">
            <span className="field-label">Token account (optional)</span>
            <input
              className="input mono"
              value={manualTokenAccount}
              onChange={(event) => setManualTokenAccount(event.target.value)}
              placeholder="ta..."
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button
            className="btn btn-ghost portfolio-add-button"
            type="submit"
          >
            Add known token
          </button>
        </div>
      </form>
    </section>
  );
}
