import { useMemo, useRef, useState, useEffect } from "react";
import { formatRawAmount } from "@thru/programs/token";
import {
  createTokenOnAlphaNet,
  verifyAndRecoverTokenOnAlphaNet,
  type CreateTokenResult,
} from "@/lib/token/thru-token";
import {
  type TokenCreationProgress,
} from "@/lib/token/workflow";
import {
  TOKEN_DECIMALS_MAX,
  TOKEN_DECIMALS_MIN,
  TOKEN_NAME_MAX_BYTES,
  TOKEN_TICKER_MAX_BYTES,
} from "@/lib/token/validation";
import {
  loadPendingSetups,
  savePendingSetups,
  upsertPendingSetup,
  removePendingSetup,
  pendingSetupsForWallet,
  type PendingTokenSetup,
} from "@/lib/token/pending-setup";
import { explorerAddressUrl, type ThruAccount } from "@/lib/wallet/thru-wallet";

interface TokenCreateFormProps {
  account: ThruAccount | null;
  onBusyChange: (busy: boolean) => void;
  onSuccess: (result: CreateTokenResult) => void;
}

export default function TokenCreateForm({
  account,
  onBusyChange,
  onSuccess,
}: TokenCreateFormProps) {
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [decimals, setDecimals] = useState("6");
  const [initialSupply, setInitialSupply] = useState("");
  const [advancedSettings, setAdvancedSettings] = useState(false);

  const [progress, setProgress] = useState<TokenCreationProgress | null>(null);
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CreateTokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- Recovery UI state ---
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryMint, setRecoveryMint] = useState("");
  const [recoveryTokenAccount, setRecoveryTokenAccount] = useState("");
  const [recoveryName, setRecoveryName] = useState("MVP Test");
  const [recoveryTicker, setRecoveryTicker] = useState("MVP");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // --- Pending setups ---
  const [pendingSetups, setPendingSetups] = useState<PendingTokenSetup[]>([]);

  const controllerRef = useRef<AbortController | null>(null);
  const recoveryControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      recoveryControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    onBusyChange(busy || recoveryBusy);
  }, [busy, recoveryBusy, onBusyChange]);

  // Load pending setups from localStorage and filter for the current wallet.
  useEffect(() => {
    if (!account?.address) {
      setPendingSetups([]);
      return;
    }
    const all = loadPendingSetups(window.localStorage);
    setPendingSetups(pendingSetupsForWallet(all, account.address));
  }, [account?.address]);

  // Pre-fill recovery form from the first pending setup.
  useEffect(() => {
    if (pendingSetups.length > 0 && !recoveryOpen) {
      const first = pendingSetups[0];
      setRecoveryMint(first.mintAddress);
      setRecoveryTokenAccount(first.tokenAccountAddress);
      setRecoveryName(first.name || "");
      setRecoveryTicker(first.ticker || "");
    }
  }, [pendingSetups, recoveryOpen]);

  const decimalValue = Number(decimals);
  const displaySupply = useMemo(() => {
    if (!result) return null;
    return formatRawAmount(result.initialSupplyRaw, result.decimals);
  }, [result]);

  // Pending-setup hooks passed down to createTokenOnAlphaNet.
  function handlePendingSetupAvailable(setup: Omit<PendingTokenSetup, "savedAt">) {
    const record: PendingTokenSetup = { ...setup, savedAt: Date.now() };
    const all = loadPendingSetups(window.localStorage);
    savePendingSetups(window.localStorage, upsertPendingSetup(all, record));
    if (account?.address) {
      setPendingSetups(pendingSetupsForWallet(
        loadPendingSetups(window.localStorage),
        account.address,
      ));
    }
  }

  function handleSetupComplete(mintAddress: string) {
    const all = loadPendingSetups(window.localStorage);
    savePendingSetups(window.localStorage, removePendingSetup(all, mintAddress));
    if (account?.address) {
      setPendingSetups(pendingSetupsForWallet(
        loadPendingSetups(window.localStorage),
        account.address,
      ));
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "validating" });
    setSignatures({});

    try {
      const created = await createTokenOnAlphaNet(
        account,
        {
          name,
          ticker,
          decimals: advancedSettings ? decimalValue : 6,
          initialSupply,
        },
        {
          signal: controller.signal,
          onProgress: (nextProgress) => {
            setProgress(nextProgress);
            if (nextProgress.signature) {
              setSignatures((current) => {
                if (nextProgress.transactionKind === "mint") {
                  return { ...current, mint: nextProgress.signature as string };
                }
                if (nextProgress.transactionKind === "token-account") {
                  return { ...current, tokenAccount: nextProgress.signature as string };
                }
                if (nextProgress.transactionKind === "initial-supply") {
                  return { ...current, initialSupply: nextProgress.signature as string };
                }
                return current;
              });
            }
          },
          onPendingSetupAvailable: handlePendingSetupAvailable,
          onSetupComplete: handleSetupComplete,
        },
      );
      setResult(created);
      setName(created.name);
      setTicker(created.ticker);
      onSuccess(created);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Token creation failed.";
      const isAborted = controller.signal.aborted;
      setError(
        isAborted
          ? "Creation was cancelled. A submitted transaction may still finalize."
          : message,
      );
      // If the creation got far enough that a pending setup was saved, show
      // a "still syncing" indicator instead of a raw error.
      if (!isAborted && pendingSetups.length > 0) {
        setError("Token created; final state is still syncing. Use \"Recover created token\" below.");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      setBusy(false);
    }
  }

  async function handleRecover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;

    const controller = new AbortController();
    recoveryControllerRef.current?.abort();
    recoveryControllerRef.current = controller;
    setRecoveryBusy(true);
    setRecoveryError(null);

    try {
      const verified = await verifyAndRecoverTokenOnAlphaNet(
        {
          mintAddress: recoveryMint,
          tokenAccountAddress: recoveryTokenAccount,
          name: recoveryName,
          ticker: recoveryTicker,
          ownerAddress: account.address,
        },
        { signal: controller.signal },
      );
      // The parent calls onSuccess which will call portfolioHook.addKnownToken.
      onSuccess({
        name: verified.name,
        ticker: verified.ticker,
        decimals: verified.decimals,
        initialSupplyRaw: verified.rawSupply,
        mintAddress: verified.mintAddress,
        tokenAccountAddress: verified.tokenAccountAddress,
        // Recovery provides no signatures — fill with empty strings.
        mintSignature: "",
        tokenAccountSignature: "",
        initialSupplySignature: "",
        mint: verified.mint,
        tokenAccount: verified.tokenAccount,
      });
      // Remove the matching pending setup if one existed.
      handleSetupComplete(verified.mintAddress);
      setRecoveryOpen(false);
    } catch (caught) {
      setRecoveryError(caught instanceof Error ? caught.message : "Recovery failed.");
    } finally {
      if (recoveryControllerRef.current === controller) {
        recoveryControllerRef.current = null;
      }
      setRecoveryBusy(false);
    }
  }

  function resetForAnotherToken() {
    setName("");
    setTicker("");
    setDecimals("6");
    setInitialSupply("");
    setProgress(null);
    setSignatures({});
    setResult(null);
    setError(null);
  }

  if (!account) {
    return (
      <div className="panel">
        <p>Create or import a wallet to use this action.</p>
      </div>
    );
  }

  const creationSteps = [
    { key: "mint", label: "Creating mint", stageIndex: 1 },
    { key: "tokenAccount", label: "Creating token account", stageIndex: 2 },
    { key: "initialSupply", label: "Minting initial supply", stageIndex: 3 },
    { key: "verify", label: "Verifying on-chain state", stageIndex: 4 },
  ];

  let currentStep = 0;
  if (progress) {
    if (progress.stage === "completed") currentStep = 5;
    else if (progress.stage === "failed" || progress.stage === "uncertain") currentStep = 5;
    else if (progress.stage === "creating-mint" || progress.stage === "waiting-mint-finalization") currentStep = 1;
    else if (progress.stage === "creating-token-account" || progress.stage === "waiting-account-finalization") currentStep = 2;
    else if (progress.stage === "minting-initial-supply") currentStep = 3;
    else if (progress.stage === "verifying-on-chain-state") currentStep = 4;
  }

  const hasPendingSetups = pendingSetups.length > 0;

  return (
    <div className="token-section">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Create</p>
          <h3>Create a new AlphaNet token</h3>
        </div>
      </div>

      <form className="token-form" onSubmit={handleSubmit}>
        <div className="token-form-grid">
          <label className="form-field">
            <span className="field-label">Token name</span>
            <input
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy || Boolean(result)}
              maxLength={TOKEN_NAME_MAX_BYTES}
              placeholder="Example Token"
              autoComplete="off"
            />
            <span className="hint">
              Token names are stored locally as labels. The on-chain Token Program stores the ticker, decimals and supply.
            </span>
          </label>

          <label className="form-field">
            <span className="field-label">Ticker / symbol</span>
            <input
              className="input mono"
              type="text"
              value={ticker}
              onChange={(event) => setTicker(event.target.value.toUpperCase())}
              disabled={busy || Boolean(result)}
              maxLength={TOKEN_TICKER_MAX_BYTES}
              placeholder="EXAMPLE"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <span className="hint">
              Starts with A-Z; then A-Z or 0-9, up to {TOKEN_TICKER_MAX_BYTES} characters.
            </span>
          </label>

          <label className="form-field">
            <span className="field-label">Initial supply</span>
            <input
              className="input mono"
              type="text"
              inputMode="decimal"
              value={initialSupply}
              onChange={(event) => setInitialSupply(event.target.value)}
              disabled={busy || Boolean(result)}
              placeholder="1000000"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
        </div>

        <div className="advanced-settings-toggle">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={advancedSettings}
              onChange={(e) => setAdvancedSettings(e.target.checked)}
              disabled={busy || Boolean(result)}
            />
            Advanced settings
          </label>
        </div>

        {advancedSettings && (
          <div className="token-form-grid" style={{ marginTop: "1rem" }}>
            <label className="form-field">
              <span className="field-label">Decimals</span>
              <input
                className="input mono"
                type="number"
                min={TOKEN_DECIMALS_MIN}
                max={TOKEN_DECIMALS_MAX}
                step="1"
                value={decimals}
                onChange={(event) => setDecimals(event.target.value)}
                disabled={busy || Boolean(result)}
              />
              <span className="hint">
                Integer from {TOKEN_DECIMALS_MIN} to {TOKEN_DECIMALS_MAX}. Default is 6.
              </span>
            </label>
          </div>
        )}

        {!result && (
          <div className="row" style={{ marginTop: "1.5rem" }}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Creating token…" : "Create token"}
            </button>
            {busy && (
              <button
                className="btn btn-link"
                type="button"
                onClick={() => controllerRef.current?.abort()}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </form>

      {progress && (
        <div className="simplified-progress" style={{ marginTop: "2rem" }}>
          <ol className="token-progress">
            {creationSteps.map((step) => {
              const state = currentStep > step.stageIndex ? "done" : currentStep === step.stageIndex ? "active" : "pending";
              return (
                <li key={step.key} className={`token-progress-item token-progress-${state}`}>
                  <span className="token-progress-node">{state === "done" ? "✓" : step.stageIndex}</span>
                  <span>{step.label}</span>
                </li>
              );
            })}
          </ol>

          {(error || Object.keys(signatures).length > 0) && (
            <details className="technical-details" style={{ marginTop: "1rem" }}>
              <summary>Technical details</summary>
              <div className="technical-details-content">
                {error && <p className="error token-error">{error}</p>}
                {Object.entries(signatures).map(([key, sig]) => (
                  <div key={key}>
                    <span>{key}: </span>
                    <a href={`https://scan.thru.org/tx/${sig}`} target="_blank" rel="noreferrer" className="mono">
                      {sig.slice(0, 10)}...{sig.slice(-8)}
                    </a>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {result && (
        <div className="token-result" style={{ marginTop: "2rem" }}>
          <div className="success-box">
            <span>✓</span>
            <span>Token created successfully.</span>
          </div>
          <dl className="token-result-grid">
            <div>
              <dt>Studio Label</dt>
              <dd>{result.name}</dd>
            </div>
            <div>
              <dt>Ticker</dt>
              <dd className="mono">{result.ticker}</dd>
            </div>
            <div>
              <dt>Total Supply</dt>
              <dd>{displaySupply}</dd>
            </div>
            <div>
              <dt>Decimals</dt>
              <dd>{result.decimals}</dd>
            </div>
          </dl>
          <div className="field">
            <span className="field-label">Mint account</span>
            <div className="field-row">
              <code className="mono field-value">{result.mintAddress}</code>
              <a
                className="icon-btn"
                href={explorerAddressUrl(result.mintAddress)}
                target="_blank"
                rel="noreferrer"
              >
                ↗
              </a>
            </div>
          </div>
          <div className="field">
            <span className="field-label">Token account</span>
            <div className="field-row">
              <code className="mono field-value">
                {result.tokenAccountAddress}
              </code>
              <a
                className="icon-btn"
                href={explorerAddressUrl(result.tokenAccountAddress)}
                target="_blank"
                rel="noreferrer"
              >
                ↗
              </a>
            </div>
          </div>
          <div style={{ marginTop: "1rem" }}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={resetForAnotherToken}
            >
              Create another token
            </button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------
          Recover created token
          Visible when there are pending setups for this wallet OR when
          the user explicitly opens the recovery panel.
          --------------------------------------------------------------- */}
      {!result && (
        <div className="token-recovery-panel" style={{ marginTop: "2.5rem", borderTop: "1px solid var(--border, #333)", paddingTop: "1.25rem" }}>
          <button
            className="btn btn-ghost"
            type="button"
            style={{ fontSize: "0.85rem", padding: "0.3rem 0.75rem" }}
            onClick={() => {
              setRecoveryOpen((v) => !v);
              setRecoveryError(null);
            }}
          >
            {hasPendingSetups ? "⚠ Recover created token" : "Recover created token"}
          </button>
          {hasPendingSetups && !recoveryOpen && (
            <p className="hint" style={{ marginTop: "0.4rem" }}>
              A pending token setup was found. Open the recovery panel to add it to your portfolio.
            </p>
          )}

          {recoveryOpen && (
            <form
              className="token-form"
              style={{ marginTop: "1rem" }}
              onSubmit={handleRecover}
            >
              <p className="hint" style={{ marginBottom: "1rem" }}>
                Paste the mint and token account addresses from a successful transaction in Thru Explorer. No transaction will be sent — only on-chain state is read.
              </p>
              <div className="token-form-grid">
                <label className="form-field">
                  <span className="field-label">Mint address</span>
                  <input
                    className="input mono"
                    type="text"
                    value={recoveryMint}
                    onChange={(e) => setRecoveryMint(e.target.value)}
                    disabled={recoveryBusy}
                    placeholder="Paste mint address from Explorer"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">Token account address</span>
                  <input
                    className="input mono"
                    type="text"
                    value={recoveryTokenAccount}
                    onChange={(e) => setRecoveryTokenAccount(e.target.value)}
                    disabled={recoveryBusy}
                    placeholder="Paste token account address from Explorer"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">Token name</span>
                  <input
                    className="input"
                    type="text"
                    value={recoveryName}
                    onChange={(e) => setRecoveryName(e.target.value)}
                    disabled={recoveryBusy}
                    maxLength={TOKEN_NAME_MAX_BYTES}
                    autoComplete="off"
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">Symbol</span>
                  <input
                    className="input mono"
                    type="text"
                    value={recoveryTicker}
                    onChange={(e) => setRecoveryTicker(e.target.value.toUpperCase())}
                    disabled={recoveryBusy}
                    maxLength={TOKEN_TICKER_MAX_BYTES}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>

              {recoveryError && (
                <p className="error token-error" style={{ marginTop: "0.75rem" }}>{recoveryError}</p>
              )}

              <div className="row" style={{ marginTop: "1rem" }}>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={recoveryBusy}
                >
                  {recoveryBusy ? "Verifying on-chain…" : "Recover token"}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => { setRecoveryOpen(false); setRecoveryError(null); }}
                  disabled={recoveryBusy}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
