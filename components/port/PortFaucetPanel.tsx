import type { AlphaNetHealth } from "./useAlphaNetHealth";
import { FAUCET_WITHDRAW_LIMIT } from "@/lib/wallet/faucet";
import {
  faucetFailureRequiresManualCheck,
  isFaucetActionDisabled,
  safeFaucetDisplayMessage,
} from "@/lib/wallet/faucet-safety";

interface PortFaucetPanelProps {
  faucetState: "idle" | "requesting" | "confirming" | "success" | "error";
  faucetError: string | null;
  retryInfo: string | null;
  lastSignature: string | null;
  health: AlphaNetHealth;
  onRequest: () => void;
  onCancel: () => void;
}

export default function PortFaucetPanel({
  faucetState,
  faucetError,
  retryInfo,
  lastSignature,
  health,
  onRequest,
  onCancel,
}: PortFaucetPanelProps) {
  const isRpcOffline = health.status === "Offline";
  const isRpcChecking = health.status === "Checking";
  const requiresManualVerification =
    faucetFailureRequiresManualCheck(faucetError);
  const isRequestDisabled =
    requiresManualVerification ||
    isFaucetActionDisabled(health.status, faucetState);

  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <h2 className="panel-title">ALPHANET FAUCET</h2>
      
      {isRpcChecking && (
        <p className="hint">Checking AlphaNet RPC…</p>
      )}
      
      {isRpcOffline && (
        <p className="error">AlphaNet RPC is currently offline.</p>
      )}

      {health.status === "Degraded" && (
        <div style={{ color: "#f59e0b", marginBottom: 12, fontSize: 14 }}>
          AlphaNet RPC is unstable. The request may take longer or fail.
        </div>
      )}

      {faucetState === "success" && (
        <div className="success-box" style={{ marginBottom: 16 }}>
          <span>✓</span> Funded!{" "}
          {lastSignature && (
            <a
              className="mono"
              style={{ color: "inherit" }}
              href={`https://scan.thru.org/tx/${lastSignature}`}
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
            onClick={onRequest}
            disabled={isRequestDisabled}
            style={isRequestDisabled ? {
              background: "rgba(0, 0, 0, 0.2)",
              color: "rgba(255, 255, 255, 0.5)",
              cursor: "not-allowed",
              boxShadow: "none",
              transform: "none",
              border: "1px solid rgba(255, 255, 255, 0.05)"
            } : undefined}
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
                href={`https://scan.thru.org/tx/${lastSignature}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check transaction on Explorer ↗
              </a>
            )}
            <button
              className="btn btn-ghost"
              type="button"
              onClick={onRequest}
              disabled={isRequestDisabled}
              aria-disabled={isRequestDisabled}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
