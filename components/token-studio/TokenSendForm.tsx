import { useState, useEffect, useMemo, useRef } from "react";
import { type TokenPortfolioItem } from "@/lib/token/thru-token";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { formatRawAmount } from "@thru/programs/token";
import { decimalAmountToRaw } from "@/lib/token/validation";
import type { NetworkHealth } from "@/components/port/useNetworkHealth";
import { useTokenTransfer } from "@/lib/token/useTokenTransfer";
import { safeTokenActionError } from "@/lib/token/network-state";
import { tokenDisplayLabels, tokenSendSourceAllowed, tokenSourceRestriction } from "@/lib/token/portfolio";
import { useTokenSendSources } from "@/lib/token/portfolio-hook";
import TokenSourcePicker from "./TokenSourcePicker";
import { explorerTransactionUrl } from "@/lib/thru/network";

export default function TokenSendForm({
  account,
  portfolio,
  onBusyChange,
  selectedTokenMint,
  health,
  onSuccess,
}: {
  account: ThruAccount | null;
  portfolio: TokenPortfolioItem[];
  onBusyChange: (busy: boolean) => void;
  selectedTokenMint?: string;
  health?: NetworkHealth;
  onSuccess?: () => void;
}) {
  const [transferDestination, setTransferDestination] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [sourceChoice, setSourceChoice] = useState("");
  const { busy, progressLabel, error, result, transfer, resetState } = useTokenTransfer({
    account,
    onSuccess,
  });

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // Clear stale state whenever the selected token context changes
  useEffect(() => {
    setTransferDestination("");
    setTransferAmount("");
    setSourceChoice("");
    resetState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTokenMint]);

  const selectedItem = useMemo(() => {
    return portfolio.find((p) => p.mintAddress === selectedTokenMint);
  }, [portfolio, selectedTokenMint]);

  const activeWalletAccounts = useTokenSendSources(selectedItem, account?.address ?? "");

  const selectedSourceAccount = sourceChoice ? activeWalletAccounts.find((source) => source.address === sourceChoice) : activeWalletAccounts[0];
  const transferSource = selectedSourceAccount?.address || "";
  const previousSource = useRef(transferSource);
  useEffect(() => {
    if (previousSource.current !== transferSource) setTransferAmount("");
    if (sourceChoice && !transferSource) { setSourceChoice(""); setTransferAmount(""); }
    previousSource.current = transferSource;
  }, [transferSource, sourceChoice]);

  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setValidationError(null);
    if (!transferAmount.trim() || !selectedSourceAccount || !selectedItem?.mint) return;

    try {
      const rawAmount = decimalAmountToRaw(transferAmount, selectedItem.mint.decimals, undefined, "Amount");
      if (rawAmount > (selectedSourceAccount.state?.amount ?? 0n)) {
        setValidationError("Insufficient token balance.");
      }
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : "Invalid amount");
    }
  }, [transferAmount, selectedSourceAccount, selectedItem]);

  const isHealthOffline = health?.status === "Offline";
  const isHealthChecking = health?.status === "Checking";
  const healthDisabled = isHealthOffline || isHealthChecking;

  const transferAllowed = Boolean(
    account && selectedTokenMint && transferSource && transferDestination && transferAmount.trim() &&
    previousSource.current === transferSource &&
    !validationError &&
    !healthDisabled
  );

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !selectedTokenMint || !transferAllowed || !tokenSendSourceAllowed(selectedItem, account.address, transferSource)) return;

    await transfer({
      selectedTokenMint,
      transferSource,
      transferDestination,
      transferAmount
    });
    setTransferAmount("");
  }

  if (!account) {
    return (
      <div className="panel">
        <p>Create or import a wallet to use this action.</p>
      </div>
    );
  }

  if (!selectedItem) {
    return (
      <div className="panel">
        <p>Select a token from the sidebar to transfer.</p>
      </div>
    );
  }

  const formattedBal = selectedSourceAccount?.state && selectedItem.mint
    ? formatRawAmount(selectedSourceAccount.state.amount, selectedItem.mint.decimals)
    : "Unavailable";
  const displayTicker = selectedItem.mint?.ticker ?? "TOKEN";
  const displayLabels = tokenDisplayLabels(
    selectedItem.label,
    selectedItem.mint?.ticker,
    "Known token",
  );

  return (
    <div className="token-section">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Send</p>
          <h3>{displayLabels.primary}</h3>
          {displayLabels.secondary && (
            <p className="mono" style={{ marginTop: 4 }}>
              {displayLabels.secondary}
            </p>
          )}
          <p style={{ marginTop: 4, color: "var(--text-muted)" }}>
            Available balance: {formattedBal} {displayTicker}
          </p>
        </div>
      </div>

      <form className="token-form" onSubmit={handleTransfer}>
        <TokenSourcePicker item={selectedItem} wallet={account.address} value={sourceChoice} disabled={busy}
          onChange={(address) => { setSourceChoice(address); setTransferAmount(""); resetState(); }} />
        {tokenSourceRestriction(selectedItem, account.address) && <p role="status">{tokenSourceRestriction(selectedItem, account.address)}</p>}
        <div className="token-form-grid" style={{ marginTop: "1rem" }}>
          <label className="form-field">
            <span className="field-label">Recipient THRU address</span>
            <input
              className="input mono"
              value={transferDestination}
              onChange={(e) => setTransferDestination(e.target.value)}
              disabled={busy}
              placeholder="ta..."
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="form-field">
            <span className="field-label">Amount</span>
            <input
              className="input mono"
              type="text"
              inputMode="decimal"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              disabled={busy}
              placeholder="1.00"
              spellCheck={false}
              autoComplete="off"
            />
            {validationError && (
              <span className="field-error" style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "4px" }}>
                {validationError}
              </span>
            )}
          </label>
        </div>

        <div className="row" style={{ marginTop: "1rem" }}>
          <button
            className="btn btn-primary token-network-action"
            type="submit"
            disabled={busy || !transferAllowed}
            style={{ width: "100%" }}
          >
            {busy ? (progressLabel || "Sending...") : "Send"}
          </button>
        </div>
      </form>

      {((error && !isHealthOffline) || result) && (
        <div className="technical-details" style={{ marginTop: "2rem" }}>
          {error && !isHealthOffline && (
            <p className="error">
              {safeTokenActionError(error, "Token transfer failed.")}
            </p>
          )}
          {result && (
            <div>
              <p className="success">Transfer successful!</p>
              <a href={explorerTransactionUrl(result.signature)} target="_blank" rel="noreferrer" className="mono">
                View on Explorer ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
