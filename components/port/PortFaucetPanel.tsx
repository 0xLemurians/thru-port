import React, { useId } from "react";
import type { NetworkHealth } from "./useNetworkHealth";
import { FAUCET_WITHDRAW_LIMIT } from "@/lib/wallet/faucet";
import {
  faucetFailureRequiresManualCheck,
  isFaucetActionDisabled,
  safeFaucetDisplayMessage,
} from "@/lib/wallet/faucet-safety";
import {
  explorerTransactionUrl,
  THRU_NETWORK,
} from "@/lib/thru/network";

interface PortFaucetPanelProps {
  accountAvailable: boolean;
  faucetState: "idle" | "requesting" | "confirming" | "success" | "error";
  faucetError: string | null;
  retryInfo: string | null;
  lastSignature: string | null;
  health: NetworkHealth;
  onRequest: () => void;
  onCancel: () => void;
}

export default function PortFaucetPanel({
  accountAvailable,
  faucetState,
  faucetError,
  retryInfo,
  lastSignature,
  health,
  onRequest,
  onCancel,
}: PortFaucetPanelProps) {
  const walletNoticeId = useId();
  const isRpcOffline = health.status === "Offline";
  const isRpcChecking = health.status === "Checking";
  const requiresManualVerification =
    faucetFailureRequiresManualCheck(faucetError);
  const isRequestDisabled =
    !accountAvailable ||
    requiresManualVerification ||
    isFaucetActionDisabled(health.status, faucetState);
  const requestFaucet = () => {
    if (!isRequestDisabled) onRequest();
  };
  const disabledStyle: React.CSSProperties | undefined = isRequestDisabled ? {
    background: "var(--surface)",
    color: "var(--text-muted)",
    opacity: 1,
    cursor: "not-allowed",
    boxShadow: "none",
    transform: "none",
    border: "1px solid var(--border-light)",
  } : undefined;

  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <h2 className="panel-title">{THRU_NETWORK.displayName.toUpperCase()} FAUCET</h2>
      {!accountAvailable && (
        <p id={walletNoticeId} className="hint" role="status" style={{ color: "var(--text-muted)" }}>
          Connect or create a wallet to request test units.
        </p>
      )}
      
      {isRpcChecking && (
        <p className="hint">Checking {THRU_NETWORK.displayName} RPC…</p>
      )}
      
      {isRpcOffline && (
        <p className="error">{THRU_NETWORK.displayName} RPC is currently offline.</p>
      )}

      {health.status === "Degraded" && (
        <div style={{ color: "#f59e0b", marginBottom: 12, fontSize: 14 }}>
          {THRU_NETWORK.displayName} RPC is unstable. The request may take longer or fail.
        </div>
      )}

      {faucetState === "success" && (
        <div className="success-box" style={{ marginBottom: 16 }}>
          <span>✓</span> Funded!{" "}
          {lastSignature && (
            <a
              className="mono"
              style={{ color: "inherit" }}
              href={explorerTransactionUrl(lastSignature)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View transaction on Explorer"
            >
              {lastSignature.slice(0, 16)}… ↗
            </a>
          )}
        </div>
      )}

      <div className="stack">
        {faucetState !== "success" && (
          <button
            className="btn btn-primary"
            type="button"
            onClick={requestFaucet}
            disabled={isRequestDisabled}
            aria-describedby={!accountAvailable ? walletNoticeId : undefined}
            style={disabledStyle}
          >
            {faucetState === "requesting"
              ? "Requesting tokens…"
              : `Get ${FAUCET_WITHDRAW_LIMIT} test units`}
          </button>
        )}

        {faucetState === "requesting" && retryInfo && (
          <p className="hint">{retryInfo}</p>
        )}

        {faucetState === "requesting" && (
          <button className="btn btn-link" type="button" onClick={onCancel}>
            Cancel request
          </button>
        )}

        {faucetState === "error" && faucetError && (
          <div className="stack">
            <p className="error">
              {safeFaucetDisplayMessage(faucetError)}
            </p>
            {lastSignature && (
              <a
                className="mono"
                href={explorerTransactionUrl(lastSignature)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check transaction on Explorer ↗
              </a>
            )}
            <button
              className="btn btn-ghost"
              type="button"
              onClick={requestFaucet}
              disabled={isRequestDisabled}
              aria-disabled={isRequestDisabled}
              aria-describedby={!accountAvailable ? walletNoticeId : undefined}
              style={disabledStyle}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
