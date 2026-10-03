"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDestinationTokenAccountOnBetanet,
  previewDestinationTokenAccount,
  type CreateDestinationTokenAccountResult,
  type TokenPortfolioItem,
} from "@/lib/token/thru-token";
import {
  TOKEN_MUTATION_STAGES,
  TOKEN_MUTATION_STAGE_LABELS,
  type TokenMutationProgress,
  type TokenMutationStage,
} from "@/lib/token/workflow";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { explorerTransactionUrl } from "@/lib/thru/network";

interface CreateDestinationTokenAccountProps {
  account: ThruAccount;
  portfolio: TokenPortfolioItem[];
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: (result: CreateDestinationTokenAccountResult) => void;
  lockedMint?: string;
}

export default function CreateDestinationTokenAccount({
  account,
  portfolio,
  disabled,
  onBusyChange,
  onCompleted,
  lockedMint,
}: CreateDestinationTokenAccountProps) {
  const [mintAddress, setMintAddress] = useState(lockedMint || "");
  const [destinationOwnerAddress, setDestinationOwnerAddress] = useState("");
  const [progress, setProgress] = useState<TokenMutationProgress | null>(null);
  const [result, setResult] =
    useState<CreateDestinationTokenAccountResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const preview = useMemo(() => {
    if (!mintAddress.trim() || !destinationOwnerAddress.trim()) return null;
    try {
      return previewDestinationTokenAccount({
        mintAddress,
        destinationOwnerAddress,
      });
    } catch {
      return null;
    }
  }, [destinationOwnerAddress, mintAddress]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (lockedMint) {
      setMintAddress(lockedMint);
    }
  }, [lockedMint]);

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) {
      setError("Enter a valid mint and destination owner address.");
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
      const next = await createDestinationTokenAccountOnBetanet(
        account,
        {
          mintAddress: preview.mintAddress,
          destinationOwnerAddress: preview.destinationOwnerAddress,
        },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      );
      setResult(next);
      onCompleted(next);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Destination token account creation failed.";
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
    <div className="token-destination-panel">
      <form className="token-action-card" onSubmit={createAccount}>
        <div>
          <p className="eyebrow token-eyebrow">Transfer preparation</p>
          <h3>Create destination token account</h3>
        </div>
        <p className="hint">
          The active wallet pays the fee and signs locally. Only the
          destination owner&apos;s public address is needed; its private key or
          recovery phrase is never requested.
        </p>
        <label className="form-field">
          <span className="field-label">Mint address</span>
          {lockedMint ? (
            <div className="input mono" style={{ opacity: 0.7, backgroundColor: "var(--bg-layer-2)" }}>
              {mintAddress}
            </div>
          ) : (
            <>
              <input
                className="input mono"
                list="destination-known-mints"
                value={mintAddress}
                onChange={(event) => {
                  setMintAddress(event.target.value);
                  setResult(null);
                }}
                placeholder="ta..."
                autoComplete="off"
                spellCheck={false}
                disabled={disabled || busy}
              />
              <datalist id="destination-known-mints">
                {portfolio.map((item) => (
                  <option key={item.mintAddress} value={item.mintAddress}>
                    {item.mint?.ticker ?? item.label ?? "Known mint"}
                  </option>
                ))}
              </datalist>
            </>
          )}
        </label>
        <label className="form-field">
          <span className="field-label">Destination owner public address</span>
          <input
            className="input mono"
            value={destinationOwnerAddress}
            onChange={(event) => {
              setDestinationOwnerAddress(event.target.value);
              setResult(null);
            }}
            placeholder="ta..."
            autoComplete="off"
            spellCheck={false}
            disabled={disabled || busy}
          />
        </label>
        <div className="derived-account-preview" aria-live="polite">
          <span className="field-label">Deterministic token account</span>
          {preview ? (
            <code className="mono">{preview.tokenAccountAddress}</code>
          ) : (
            <span className="hint">
              Enter valid public addresses to preview before submission.
            </span>
          )}
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={disabled || busy || !preview}
        >
          {busy
            ? "Creating destination account..."
            : "Create destination token account"}
        </button>
      </form>

      {(progress || error || result) && (
        <div className="token-mutation-status">
          <div className="token-section-header">
            <h3>Destination account status</h3>
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
          {progress && (!result || result.created) && (
            <DestinationProgress progress={progress} />
          )}
          {(result?.signature || progress?.signature) && (
            <TransactionLink
              signature={result?.signature ?? progress?.signature ?? ""}
            />
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
                " The expected on-chain account was observed, but final consensus remains unconfirmed."}
            </p>
          )}
          {result && (
            <div className="token-destination-result">
              <p className="success">
                {result.created
                  ? "Destination token account created and verified on-chain."
                  : "The deterministic account already existed; no transaction was sent."}
              </p>
              <dl className="portfolio-account-details">
                <div>
                  <dt>Token</dt>
                  <dd>
                    {result.mint.ticker} / {result.mint.decimals} decimals
                  </dd>
                </div>
                <div>
                  <dt>Token account</dt>
                  <dd className="mono">{result.tokenAccountAddress}</dd>
                </div>
                <div>
                  <dt>Mint</dt>
                  <dd className="mono">{result.tokenAccount.mint}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd className="mono">{result.tokenAccount.owner}</dd>
                </div>
                <div>
                  <dt>Balance / frozen</dt>
                  <dd>
                    {result.tokenAccount.amount.toString()} raw /{" "}
                    {result.tokenAccount.isFrozen ? "Frozen" : "Active"}
                  </dd>
                </div>
              </dl>
              <p className="hint">
                Account creation and token transfer remain separate actions.
                Select this account in the transfer form when ready.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DestinationProgress({
  progress,
}: {
  progress: TokenMutationProgress;
}) {
  return (
    <ol
      className="token-progress"
      aria-label="Destination token account progress"
    >
      {TOKEN_MUTATION_STAGES.map((stage, index) => {
        const state = progressState(stage, progress);
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
            <span>{TOKEN_MUTATION_STAGE_LABELS[stage]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function progressState(
  stage: (typeof TOKEN_MUTATION_STAGES)[number],
  progress: TokenMutationProgress,
): "pending" | "active" | "done" | "failed" | "uncertain" {
  const stageIndex = TOKEN_MUTATION_STAGES.indexOf(stage);
  if (progress.stage === "failed") {
    const failedIndex = progress.failedAt
      ? TOKEN_MUTATION_STAGES.indexOf(progress.failedAt)
      : 0;
    if (stageIndex < failedIndex) return "done";
    if (stageIndex === failedIndex) return "failed";
    return "pending";
  }
  if (progress.stage === "uncertain") {
    const uncertainIndex = progress.uncertainAt
      ? TOKEN_MUTATION_STAGES.indexOf(progress.uncertainAt)
      : 0;
    if (stageIndex < uncertainIndex) return "done";
    if (stageIndex === uncertainIndex || stage === "completed") {
      return "uncertain";
    }
    return "pending";
  }
  const activeIndex = TOKEN_MUTATION_STAGES.indexOf(
    progress.stage as Exclude<TokenMutationStage, "failed" | "uncertain">,
  );
  if (progress.stage === "completed" || stageIndex < activeIndex) return "done";
  if (stageIndex === activeIndex) return "active";
  return "pending";
}

function TransactionLink({ signature }: { signature: string }) {
  return (
    <a
      className="transaction-link"
      href={explorerTransactionUrl(signature)}
      target="_blank"
      rel="noreferrer"
      title={signature}
    >
      <span>Destination account</span>
      <code className="mono">{shortAddress(signature)}</code>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}
