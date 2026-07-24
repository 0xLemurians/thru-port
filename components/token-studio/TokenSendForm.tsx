import { useState, useRef, useEffect, useMemo } from "react";
import { transferTokensOnAlphaNet, type TokenPortfolioItem, type TransferTokenResult } from "@/lib/token/thru-token";
import type { TokenMutationProgress } from "@/lib/token/workflow";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import CreateDestinationTokenAccount from "@/components/CreateDestinationTokenAccount";

export default function TokenSendForm({
  account,
  portfolio,
  onBusyChange,
}: {
  account: ThruAccount | null;
  portfolio: TokenPortfolioItem[];
  onBusyChange: (busy: boolean) => void;
}) {
  const [transferMint, setTransferMint] = useState("");
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

  const activeWalletAccounts = useMemo(() => {
    if (!account) return [];
    return portfolio
      .filter((item) => item.mintAddress === transferMint)
      .flatMap((item) => item.tokenAccounts)
      .filter((acc) => acc.state?.owner === account.address);
  }, [account, portfolio, transferMint]);

  // Actually, allow them to just paste any destination token account.
  // The transfer destination is usually just pasted.
  
  const transferAllowed = Boolean(
    account && transferMint && transferSource && transferDestination &&
    transferSource !== transferDestination
  );

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;

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
            <select
              className="input mono"
              value={transferMint}
              onChange={(e) => {
                setTransferMint(e.target.value);
                setTransferSource("");
              }}
              disabled={busy}
            >
              <option value="">Select token</option>
              {portfolio
                .filter(item => item.tokenAccounts.some(acc => acc.state?.owner === account.address))
                .map((item) => (
                <option key={item.mintAddress} value={item.mintAddress}>
                  {item.mint?.ticker ?? "TOKEN"} - {item.mintAddress.slice(0,10)}...
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span className="field-label">Source token account</span>
            <select
              className="input mono"
              value={transferSource}
              onChange={(e) => setTransferSource(e.target.value)}
              disabled={busy || !transferMint}
            >
              <option value="">Select source account</option>
              {activeWalletAccounts.map((acc) => (
                <option key={acc.address} value={acc.address}>
                  {acc.address.slice(0,10)}... (Bal: {acc.state?.amount.toString()})
                </option>
              ))}
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
          </label>
        </div>

        <div className="row" style={{ marginTop: "1rem" }}>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || !transferAllowed || !transferAmount.trim()}
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
              onCompleted={(res) => {
                if (res.tokenAccountAddress) {
                  setTransferMint(res.mintAddress);
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
