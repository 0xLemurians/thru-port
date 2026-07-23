"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatRawAmount } from "@thru/programs/token";
import {
  createTokenOnAlphaNet,
  type CreateTokenResult,
} from "@/lib/token/thru-token";
import {
  TOKEN_CREATION_STAGES,
  TOKEN_CREATION_STAGE_LABELS,
  type TokenCreationProgress,
  type TokenCreationStage,
} from "@/lib/token/workflow";
import {
  TOKEN_AMOUNT_MAX_RAW,
  TOKEN_DECIMALS_MAX,
  TOKEN_DECIMALS_MIN,
  TOKEN_NAME_MAX_BYTES,
  TOKEN_TICKER_MAX_BYTES,
} from "@/lib/token/validation";
import {
  explorerAddressUrl,
  type ThruAccount,
} from "@/lib/wallet/thru-wallet";
import TokenPortfolio from "./TokenPortfolio";

interface TokenStudioProps {
  account: ThruAccount;
  onBusyChange?: (busy: boolean) => void;
}

interface TransactionSignatures {
  mint?: string;
  tokenAccount?: string;
  initialSupply?: string;
}

const DISPLAY_STAGES = TOKEN_CREATION_STAGES;

function explorerTransactionUrl(signature: string): string {
  return `https://scan.thru.org/tx/${signature}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

export default function TokenStudio({
  account,
  onBusyChange,
}: TokenStudioProps) {
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [decimals, setDecimals] = useState("6");
  const [initialSupply, setInitialSupply] = useState("");
  const [progress, setProgress] = useState<TokenCreationProgress | null>(null);
  const [signatures, setSignatures] = useState<TransactionSignatures>({});
  const [result, setResult] = useState<CreateTokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    onBusyChange?.(busy || portfolioBusy);
  }, [busy, onBusyChange, portfolioBusy]);

  const decimalValue = Number(decimals);
  const displaySupply = useMemo(() => {
    if (!result) return null;
    return formatRawAmount(result.initialSupplyRaw, result.decimals);
  }, [result]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
          decimals: decimalValue,
          initialSupply,
        },
        {
          signal: controller.signal,
          onProgress: (nextProgress) => {
            setProgress(nextProgress);
            if (nextProgress.signature) {
              setSignatures((current) => {
                if (nextProgress.transactionKind === "mint") {
                  return { ...current, mint: nextProgress.signature };
                }
                if (nextProgress.transactionKind === "token-account") {
                  return {
                    ...current,
                    tokenAccount: nextProgress.signature,
                  };
                }
                if (nextProgress.transactionKind === "initial-supply") {
                  return {
                    ...current,
                    initialSupply: nextProgress.signature,
                  };
                }
                return current;
              });
            }
          },
        },
      );
      setResult(created);
      setName(created.name);
      setTicker(created.ticker);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Token creation failed.";
      setError(
        controller.signal.aborted
          ? "Creation was cancelled. A submitted transaction may still finalize; inspect the transaction links before retrying."
          : message,
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      setBusy(false);
    }
  }

  function cancelCreation() {
    controllerRef.current?.abort();
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

  return (
    <div className="panel token-studio">
      <div className="token-studio-header">
        <div>
          <p className="eyebrow token-eyebrow">Token Studio · Phase 2</p>
          <h2 className="panel-title">Create and manage fungible tokens</h2>
        </div>
        <span className="account-chip mono" title={account.address}>
          {shortAddress(account.address)}
        </span>
      </div>

      <div className="experimental-box" role="note">
        <strong>AlphaNet experimental — test tokens have no monetary value.</strong>
        <span>
          This flow submits three separate transactions. AlphaNet may reset at
          any time.
        </span>
      </div>

      <TokenPortfolio
        account={account}
        createdToken={result}
        onBusyChange={setPortfolioBusy}
      />

      <form className="token-form" onSubmit={handleSubmit}>
        <div className="token-form-grid">
          <label className="form-field">
            <span className="field-label">Token name</span>
            <input
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy || portfolioBusy || Boolean(result)}
              maxLength={TOKEN_NAME_MAX_BYTES}
              placeholder="Example Token"
              autoComplete="off"
            />
            <span className="hint">
              Studio label only; the Token Program does not store this name
              on-chain. Maximum {TOKEN_NAME_MAX_BYTES} UTF-8 bytes.
            </span>
          </label>

          <label className="form-field">
            <span className="field-label">Ticker / symbol</span>
            <input
              className="input mono"
              type="text"
              value={ticker}
              onChange={(event) => setTicker(event.target.value.toUpperCase())}
              disabled={busy || portfolioBusy || Boolean(result)}
              maxLength={TOKEN_TICKER_MAX_BYTES}
              placeholder="EXAMPLE"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              Starts with A-Z; then A-Z or 0-9, up to{" "}
              {TOKEN_TICKER_MAX_BYTES} characters.
            </span>
          </label>

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
              disabled={busy || portfolioBusy || Boolean(result)}
            />
            <span className="hint">
              Integer from {TOKEN_DECIMALS_MIN} to {TOKEN_DECIMALS_MAX}.
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
              disabled={busy || portfolioBusy || Boolean(result)}
              placeholder="1000000"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              Plain decimal notation. Raw supply must fit unsigned 64-bit
              maximum {TOKEN_AMOUNT_MAX_RAW.toString()}.
            </span>
          </label>
        </div>

        <div className="authority-box">
          <span className="field-label">Mint authority · active wallet</span>
          <code className="mono">{account.address}</code>
          <span className="hint">
            The private key stays in this browser tab and signs locally. It is
            not stored in localStorage or sent as request data.
          </span>
        </div>

        {!result && (
          <div className="row">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || portfolioBusy}
            >
              {busy ? "Creating token…" : "Create token in 3 transactions"}
            </button>
            {busy && (
              <button
                className="btn btn-link"
                type="button"
                onClick={cancelCreation}
              >
                Cancel tracking
              </button>
            )}
          </div>
        )}
      </form>

      {progress && (
        <ol className="token-progress" aria-label="Token creation progress">
          {DISPLAY_STAGES.map((stage, index) => {
            const state = progressState(stage, progress);
            const label =
              stage === "completed"
                ? "Completed / Failed"
                : TOKEN_CREATION_STAGE_LABELS[stage];
            return (
              <li
                key={stage}
                className={`token-progress-item token-progress-${state}`}
                aria-current={state === "active" ? "step" : undefined}
              >
                <span className="token-progress-node" aria-hidden="true">
                  {state === "done"
                    ? "✓"
                    : state === "failed"
                      ? "!"
                      : state === "uncertain"
                        ? "?"
                        : index + 1}
                </span>
                <span>{label}</span>
              </li>
            );
          })}
        </ol>
      )}

      {(signatures.mint ||
        signatures.tokenAccount ||
        signatures.initialSupply) && (
        <div className="transaction-list">
          <h3>Transactions</h3>
          {signatures.mint && (
            <TransactionLink label="Mint creation" signature={signatures.mint} />
          )}
          {signatures.tokenAccount && (
            <TransactionLink
              label="Token account creation"
              signature={signatures.tokenAccount}
            />
          )}
          {signatures.initialSupply && (
            <TransactionLink
              label="Initial supply mint"
              signature={signatures.initialSupply}
            />
          )}
        </div>
      )}

      {error && (
        <p
          className={
            progress?.stage === "uncertain"
              ? "token-uncertain-box"
              : "error token-error"
          }
        >
          {error}
          {progress?.stage === "uncertain" &&
            progress.expectedStateObserved &&
            " The expected on-chain account state was observed, but final consensus remains unconfirmed."}
        </p>
      )}

      {result && (
        <div className="token-result">
          <div className="success-box">
            <span>✓</span>
            <span>
              All three transactions finalized, executed successfully, and
              matched the refetched on-chain state.
            </span>
          </div>
          <dl className="token-result-grid">
            <div>
              <dt>Name · Studio only</dt>
              <dd>{result.name}</dd>
            </div>
            <div>
              <dt>Ticker</dt>
              <dd className="mono">{result.ticker}</dd>
            </div>
            <div>
              <dt>Supply</dt>
              <dd>
                {displaySupply}{" "}
                <span className="unit">({result.initialSupplyRaw.toString()} raw)</span>
              </dd>
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
                aria-label="View mint account on explorer"
              >
                ↗
              </a>
            </div>
          </div>
          <div className="field">
            <span className="field-label">Your token account</span>
            <div className="field-row">
              <code className="mono field-value">
                {result.tokenAccountAddress}
              </code>
              <a
                className="icon-btn"
                href={explorerAddressUrl(result.tokenAccountAddress)}
                target="_blank"
                rel="noreferrer"
                aria-label="View token account on explorer"
              >
                ↗
              </a>
            </div>
          </div>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={resetForAnotherToken}
          >
            Prepare another token
          </button>
        </div>
      )}
    </div>
  );
}

function TransactionLink({
  label,
  signature,
}: {
  label: string;
  signature: string;
}) {
  return (
    <a
      className="transaction-link"
      href={explorerTransactionUrl(signature)}
      target="_blank"
      rel="noreferrer"
      title={signature}
    >
      <span>{label}</span>
      <code className="mono">{shortAddress(signature)}</code>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

type ProgressState = "pending" | "active" | "done" | "failed" | "uncertain";

function progressState(
  stage: (typeof DISPLAY_STAGES)[number],
  progress: TokenCreationProgress,
): ProgressState {
  const stageIndex = DISPLAY_STAGES.indexOf(stage);
  if (progress.stage === "failed") {
    const failedIndex = progress.failedAt
      ? DISPLAY_STAGES.indexOf(progress.failedAt)
      : 0;
    if (stageIndex < failedIndex) return "done";
    if (stageIndex === failedIndex || stage === "completed") return "failed";
    return "pending";
  }
  if (progress.stage === "uncertain") {
    const uncertainIndex = progress.uncertainAt
      ? DISPLAY_STAGES.indexOf(progress.uncertainAt)
      : 0;
    if (stageIndex < uncertainIndex) return "done";
    if (stageIndex === uncertainIndex || stage === "completed") {
      return "uncertain";
    }
    return "pending";
  }

  const activeIndex = DISPLAY_STAGES.indexOf(
    progress.stage as Exclude<TokenCreationStage, "failed" | "uncertain">,
  );
  if (progress.stage === "completed" || stageIndex < activeIndex) return "done";
  if (stageIndex === activeIndex) return "active";
  return "pending";
}
