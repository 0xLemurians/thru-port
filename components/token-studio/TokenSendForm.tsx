import { useState, useRef, useEffect, useMemo } from "react";
import { transferTokensOnAlphaNet, type TokenPortfolioItem, type TransferTokenResult } from "@/lib/token/thru-token";
import type { TokenMutationProgress } from "@/lib/token/workflow";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import CreateDestinationTokenAccount from "@/components/CreateDestinationTokenAccount";
import { formatRawAmount } from "@thru/programs/token";
import { decimalAmountToRaw } from "@/lib/token/validation";
import type { AlphaNetHealth } from "@/components/port/useAlphaNetHealth";

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
  health?: AlphaNetHealth;
  onSuccess?: () => void;
}) {
  const [transferSource, setTransferSource] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TokenMutationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransferTokenResult | null>(null);
  const [showPrepareRecipient, setShowPrepareRecipient] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // Clear stale state whenever the selected token context changes
  useEffect(() => {
    setTransferSource("");
    setTransferDestination("");
    setTransferAmount("");
    setError(null);
    setResult(null);
    setProgress(null);
    setShowPrepareRecipient(false);
  }, [selectedTokenMint]);

  const selectedItem = useMemo(() => {
    return portfolio.find((p) => p.mintAddress === selectedTokenMint);
  }, [portfolio, selectedTokenMint]);

  const activeWalletAccounts = useMemo(() => {
    if (!account || !selectedItem) return [];
    return selectedItem.tokenAccounts.filter((acc) => acc.state?.owner === account.address);
  }, [account, selectedItem]);

  // Auto-select source if there's exactly one
  useEffect(() => {
    if (activeWalletAccounts.length === 1 && !transferSource) {
      setTransferSource(activeWalletAccounts[0].address);
    }
  }, [activeWalletAccounts, transferSource]);

  const selectedSourceAccount = useMemo(() => {
    return activeWalletAccounts.find(acc => acc.address === transferSource);
  }, [activeWalletAccounts, transferSource]);

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
  const isHealthDegraded = health?.status === "Degraded";
  const healthDisabled = isHealthOffline || isHealthChecking;

  const transferAllowed = Boolean(
    account && selectedTokenMint && transferSource && transferDestination && transferAmount.trim() &&
    transferSource !== transferDestination &&
    !validationError &&
    !healthDisabled
  );

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !selectedTokenMint || !transferAllowed) return;

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "validating" });

    try {
      const next = await transferTokensOnAlphaNet(
        account,
        {
          sourceAddress: transferSource,
          destinationAddress: transferDestination,
          amount: transferAmount,
        },
        {
          signal: controller.signal,
          onProgress: setProgress,
        }
      );
      setResult(next);
      setTransferAmount("");
      if (onSuccess) onSuccess();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Transfer failed.";
      setError(
        controller.signal.aborted
          ? "Cancelled."
          : message
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      setBusy(false);
    }
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

  return (
    <div className="token-section">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Send</p>
          <h3>Transfer tokens</h3>
        </div>
      </div>

      <form className="token-form" onSubmit={handleTransfer}>
        <div className="token-form-grid">
          <label className="form-field">
            <span className="field-label">Token</span>
            <div className="input mono" style={{ opacity: 0.7, backgroundColor: "var(--bg-layer-2)" }}>
              {selectedItem.mint?.ticker ?? "TOKEN"} &mdash; {selectedTokenMint?.slice(0, 10)}...
            </div>
          </label>

          <label className="form-field">
            <span className="field-label">Source token account</span>
            <select
              className="input mono"
              value={transferSource}
              onChange={(e) => setTransferSource(e.target.value)}
              disabled={busy || activeWalletAccounts.length === 0}
            >
              <option value="">Select source account</option>
              {activeWalletAccounts.map((acc) => {
                const formattedBal = acc.state && selectedItem.mint ? formatRawAmount(acc.state.amount, selectedItem.mint.decimals) : "0";
                const displayTicker = selectedItem.mint?.ticker ?? "TOKEN";
                return (
                  <option key={acc.address} value={acc.address}>
                    {acc.address.slice(0,10)}... (Bal: {formattedBal} {displayTicker})
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        <div className="token-form-grid" style={{ marginTop: "1rem" }}>
          <label className="form-field">
            <span className="field-label">Recipient token account</span>
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
              <span className="field-error" style={{ color: "var(--accent-red)", fontSize: "0.85rem", marginTop: "4px" }}>
                {validationError}
              </span>
            )}
          </label>
        </div>

        {healthDisabled && (
          <div className="notice" style={{ marginTop: "1rem", color: "var(--accent-red)" }}>
            Cannot transfer tokens while AlphaNet is {health.status.toLowerCase()}.
          </div>
        )}

        {isHealthDegraded && !busy && (
          <div className="notice" style={{ marginTop: "1rem", color: "var(--accent-amber)" }}>
            AlphaNet is degraded. Transfers may take longer than usual.
          </div>
        )}

        <div className="row" style={{ marginTop: "1rem" }}>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !transferAllowed}
          >
            {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </form>

      <div style={{ marginTop: "2rem" }}>
        <p className="hint">
          This recipient does not have a token account for this token?
        </p>
        <button
          className="btn btn-ghost"
          onClick={() => setShowPrepareRecipient(!showPrepareRecipient)}
        >
          {showPrepareRecipient ? "Cancel preparation" : "Prepare recipient"}
        </button>
        
        {showPrepareRecipient && (
          <div style={{ marginTop: "1rem", padding: "1rem", border: "1px solid #333", borderRadius: "8px" }}>
            <CreateDestinationTokenAccount
              account={account}
              portfolio={portfolio}
              disabled={busy}
              onBusyChange={setBusy}
              lockedMint={selectedTokenMint}
              onCompleted={(res) => {
                if (res.tokenAccountAddress) {
                  setTransferDestination(res.tokenAccountAddress);
                  setShowPrepareRecipient(false);
                }
              }}
            />
          </div>
        )}
      </div>

      {(progress || error || result) && (
        <div className="technical-details" style={{ marginTop: "2rem" }}>
          <div className="token-section-header">
            <h4>Transfer status</h4>
            {busy && (
              <button className="btn btn-link" onClick={() => controllerRef.current?.abort()}>
                Cancel
              </button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
          {result && (
            <div>
              <p className="success">Transfer successful!</p>
              <a href={`https://scan.thru.org/tx/${result.signature}`} target="_blank" rel="noreferrer" className="mono">
                View on Explorer ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
