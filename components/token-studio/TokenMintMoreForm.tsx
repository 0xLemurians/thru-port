import { useState, useRef, useEffect, useMemo } from "react";
import { mintAdditionalSupplyOnAlphaNet, type TokenPortfolioItem, type MintAdditionalSupplyResult } from "@/lib/token/thru-token";
import type { TokenMutationProgress } from "@/lib/token/workflow";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

export default function TokenMintMoreForm({
  account,
  portfolio,
  onBusyChange,
}: {
  account: ThruAccount | null;
  portfolio: TokenPortfolioItem[];
  onBusyChange: (busy: boolean) => void;
}) {
  const [mintAddress, setMintAddress] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [amount, setAmount] = useState("");
  
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TokenMutationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MintAdditionalSupplyResult | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  const activeWalletMints = useMemo(() => {
    if (!account) return [];
    return portfolio.filter(item => item.mint?.mintAuthority === account.address);
  }, [account, portfolio]);

  const allAccountsForMint = useMemo(() => {
    return portfolio
      .filter(item => item.mintAddress === mintAddress)
      .flatMap(item => item.tokenAccounts);
  }, [portfolio, mintAddress]);

  const mintAllowed = Boolean(
    account && mintAddress && destinationAddress &&
    activeWalletMints.some(m => m.mintAddress === mintAddress)
  );

  async function handleMint(e: React.FormEvent) {
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
      const next = await mintAdditionalSupplyOnAlphaNet(
        account,
        {
          mintAddress,
          destinationAddress,
          amount,
        },
        {
          signal: controller.signal,
          onProgress: setProgress,
        }
      );
      setResult(next);
      setAmount("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Mint failed.";
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
          <p className="eyebrow token-eyebrow">Mint More</p>
          <h3>Mint additional supply</h3>
        </div>
      </div>

      {activeWalletMints.length === 0 ? (
        <p className="hint">
          You are not the mint authority for any known tokens.
        </p>
      ) : (
        <form className="token-form" onSubmit={handleMint}>
          <div className="token-form-grid">
            <label className="form-field">
              <span className="field-label">Token (where you are mint authority)</span>
              <select
                className="input mono"
                value={mintAddress}
                onChange={(e) => {
                  setMintAddress(e.target.value);
                  setDestinationAddress("");
                }}
                disabled={busy}
              >
                <option value="">Select token</option>
                {activeWalletMints.map((item) => (
                  <option key={item.mintAddress} value={item.mintAddress}>
                    {item.mint?.ticker ?? "TOKEN"} - {item.mintAddress.slice(0,10)}...
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="field-label">Destination token account</span>
              <select
                className="input mono"
                value={destinationAddress}
                onChange={(e) => setDestinationAddress(e.target.value)}
                disabled={busy || !mintAddress}
              >
                <option value="">Select destination</option>
                {allAccountsForMint.map((acc) => (
                  <option key={acc.address} value={acc.address}>
                    {acc.address.slice(0,10)}... (Bal: {acc.state?.amount.toString()})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="token-form-grid" style={{ marginTop: "1rem" }}>
            <label className="form-field">
              <span className="field-label">Amount</span>
              <input
                className="input mono"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
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
              disabled={busy || !mintAllowed || !amount.trim()}
            >
              {busy ? "Minting..." : "Mint additional supply"}
            </button>
          </div>
        </form>
      )}

      {(progress || error || result) && (
        <div className="technical-details" style={{ marginTop: "2rem" }}>
          <div className="token-section-header">
            <h4>Mint status</h4>
            {busy && (
              <button className="btn btn-link" onClick={() => controllerRef.current?.abort()}>
                Cancel
              </button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
          {result && (
            <div>
              <p className="success">Mint successful!</p>
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
