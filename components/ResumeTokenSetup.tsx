"use client";

import { useEffect, useRef, useState } from "react";
import {
  resumeTokenSetupOnAlphaNet,
  type ResumeTokenSetupResult,
  type TokenPortfolioItem,
} from "@/lib/token/thru-token";
import {
  TOKEN_RESUME_STAGES,
  TOKEN_RESUME_STAGE_LABELS,
  type TokenResumeProgress,
  type TokenResumeStage,
} from "@/lib/token/resume";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

interface ResumeTokenSetupProps {
  account: ThruAccount;
  portfolio: TokenPortfolioItem[];
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: (result: ResumeTokenSetupResult) => void;
}

export default function ResumeTokenSetup({
  account,
  portfolio,
  disabled,
  onBusyChange,
  onCompleted,
}: ResumeTokenSetupProps) {
  const [mintAddress, setMintAddress] = useState("");
  const [initialSupply, setInitialSupply] = useState("");
  const [supplyConfirmed, setSupplyConfirmed] = useState(false);
  const [progress, setProgress] = useState<TokenResumeProgress | null>(null);
  const [result, setResult] = useState<ResumeTokenSetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  async function resume(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplyConfirmed) {
      setError("Confirm the initial-supply amount before continuing.");
      return;
    }

    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "validating" });

    try {
      const next = await resumeTokenSetupOnAlphaNet(
        account,
        { mintAddress, initialSupply },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      );
      setResult(next);
      onCompleted(next);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Token setup could not resume.";
      setError(
        controller.signal.aborted
          ? "Tracking was cancelled. A submitted transaction may still finalize; inspect its Explorer link before taking another action."
          : message,
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      setBusy(false);
    }
  }

  return (
    <div className="token-resume-panel">
      <form className="token-action-card" onSubmit={resume}>
        <div>
          <p className="eyebrow token-eyebrow">Recovery</p>
          <h3>Resume token setup</h3>
        </div>
        <p className="hint">
          Uses an existing mint only. The mint is refetched, its authority is
          checked against the active wallet, and already completed steps are
          skipped. No transaction is retried automatically.
        </p>
        <label className="form-field">
          <span className="field-label">Existing mint</span>
          <input
            className="input mono"
            list="resume-known-mints"
            value={mintAddress}
            onChange={(event) => setMintAddress(event.target.value)}
            placeholder="ta..."
            autoComplete="off"
            spellCheck={false}
            disabled={disabled || busy}
          />
          <datalist id="resume-known-mints">
            {portfolio.map((item) => (
              <option key={item.mintAddress} value={item.mintAddress}>
                {item.mint?.ticker ?? item.label ?? "Known mint"}
              </option>
            ))}
          </datalist>
        </label>
        <label className="form-field">
          <span className="field-label">Confirmed initial supply</span>
          <input
            className="input mono"
            type="text"
            inputMode="decimal"
            value={initialSupply}
            onChange={(event) => {
              setInitialSupply(event.target.value);
              setSupplyConfirmed(false);
            }}
            placeholder="100"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled || busy}
          />
          <span className="hint">
            Decimals are read from the mint; the value is converted with
            BigInt. If mint supply is already non-zero, initial minting is
            skipped.
          </span>
        </label>
        <label className="token-confirmation">
          <input
            type="checkbox"
            checked={supplyConfirmed}
            onChange={(event) => setSupplyConfirmed(event.target.checked)}
            disabled={disabled || busy || !initialSupply.trim()}
          />
          <span>
            I confirm this initial-supply amount. Mint it only if on-chain
            supply is still zero.
          </span>
        </label>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={
            disabled ||
            busy ||
            !mintAddress.trim() ||
            !initialSupply.trim() ||
            !supplyConfirmed
          }
        >
          {busy ? "Resuming..." : "Resume token setup"}
        </button>
      </form>

      {progress && (
        <div className="token-mutation-status">
          <div className="token-section-header">
            <h3>Resume progress</h3>
            {busy && (
              <button
                className="btn btn-link"
                type="button"
                onClick={() => controllerRef.current?.abort()}
              >
                Cancel tracking
              </button>
            )}
          </div>
          <ResumeProgress progress={progress} />
          {progress.detail && <p className="hint">{progress.detail}</p>}
          {progress.signature && (
            <TransactionLink
              label={
                progress.transactionKind === "token-account"
                  ? "Token account"
                  : "Initial supply"
              }
              signature={progress.signature}
            />
          )}
          {error && (
            <p
              className={
                progress.stage === "uncertain"
                  ? "token-uncertain-box"
                  : "error token-error"
              }
            >
              {error}
              {progress.stage === "uncertain" &&
                progress.expectedStateObserved &&
                " The expected on-chain account state was observed, but final consensus remains unconfirmed."}
            </p>
          )}
          {result && (
            <div className="token-resume-result">
              <p className="success">
                Existing mint setup verified on-chain.
              </p>
              <dl className="portfolio-account-details">
                <div>
                  <dt>Token account</dt>
                  <dd className="mono">{result.tokenAccountAddress}</dd>
                </div>
                <div>
                  <dt>Account step</dt>
                  <dd>{result.tokenAccountCreated ? "Created" : "Skipped"}</dd>
                </div>
                <div>
                  <dt>Initial supply</dt>
                  <dd>{result.initialSupplyMinted ? "Minted" : "Skipped"}</dd>
                </div>
                <div>
                  <dt>Raw supply</dt>
                  <dd>{result.mint.supply.toString()}</dd>
                </div>
              </dl>
              {result.tokenAccountSignature && (
                <TransactionLink
                  label="Token account"
                  signature={result.tokenAccountSignature}
                />
              )}
              {result.initialSupplySignature && (
                <TransactionLink
                  label="Initial supply"
                  signature={result.initialSupplySignature}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResumeProgress({ progress }: { progress: TokenResumeProgress }) {
  return (
    <ol className="token-progress" aria-label="Resume token setup progress">
      {TOKEN_RESUME_STAGES.map((stage, index) => {
        const state = resumeProgressState(stage, progress);
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
            <span>{TOKEN_RESUME_STAGE_LABELS[stage]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function resumeProgressState(
  stage: (typeof TOKEN_RESUME_STAGES)[number],
  progress: TokenResumeProgress,
): "pending" | "active" | "done" | "failed" | "uncertain" {
  const stageIndex = TOKEN_RESUME_STAGES.indexOf(stage);
  if (progress.stage === "failed") {
    const failedIndex = progress.failedAt
      ? TOKEN_RESUME_STAGES.indexOf(progress.failedAt)
      : 0;
    if (stageIndex < failedIndex) return "done";
    if (stageIndex === failedIndex) return "failed";
    return "pending";
  }
  if (progress.stage === "uncertain") {
    const uncertainIndex = progress.uncertainAt
      ? TOKEN_RESUME_STAGES.indexOf(progress.uncertainAt)
      : 0;
    if (stageIndex < uncertainIndex) return "done";
    if (stageIndex === uncertainIndex || stage === "completed") {
      return "uncertain";
    }
    return "pending";
  }
  const activeIndex = TOKEN_RESUME_STAGES.indexOf(
    progress.stage as Exclude<TokenResumeStage, "failed" | "uncertain">,
  );
  if (progress.stage === "completed" || stageIndex < activeIndex) return "done";
  if (stageIndex === activeIndex) return "active";
  return "pending";
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
      href={`https://scan.thru.org/tx/${signature}`}
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

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}
