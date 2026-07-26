"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { bytesToHex } from "@/lib/wallet/thru-wallet";
import {
  INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
  PRIVATE_KEY_COPY_ERROR_MESSAGE,
  PRIVATE_KEY_COPY_STATUS_MS,
  PRIVATE_KEY_COPY_SUCCESS_MESSAGE,
  PRIVATE_KEY_MASK,
  copyPrivateKeyToClipboard,
  reduceOneTimePrivateKeyBackupState,
  schedulePrivateKeyAutoHide,
} from "@/lib/wallet/one-time-private-key-backup";
import WalletBackupDialog from "./WalletBackupDialog";

interface OneTimePrivateKeyBackupProps {
  account: ThruAccount;
  onContinue: () => Promise<boolean>;
}

function EyeIcon() {
  return (
    <svg
      data-private-key-icon="eye-open"
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      data-private-key-icon="eye-off"
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 3 18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a17.7 17.7 0 0 1-2 3.2" />
      <path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 4.1-.9" />
    </svg>
  );
}

export default function OneTimePrivateKeyBackup({
  account,
  onContinue,
}: OneTimePrivateKeyBackupProps) {
  const [state, dispatch] = useReducer(
    reduceOneTimePrivateKeyBackupState,
    INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE,
  );
  const displayRef = useRef<HTMLElement>(null);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const [continuePending, setContinuePending] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const clearAutoHideTimer = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  const clearCopyStatusTimer = useCallback(() => {
    if (copyStatusTimerRef.current) {
      clearTimeout(copyStatusTimerRef.current);
      copyStatusTimerRef.current = null;
    }
  }, []);

  const hidePrivateKey = useCallback(() => {
    clearAutoHideTimer();
    dispatch({ type: "hide" });
  }, [clearAutoHideTimer]);

  useEffect(() => {
    mountedRef.current = true;
    const displayElement = displayRef.current;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") hidePrivateKey();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearAutoHideTimer();
      clearCopyStatusTimer();
      copyPendingRef.current = false;
      if (displayElement) displayElement.textContent = "";
    };
  }, [clearAutoHideTimer, clearCopyStatusTimer, hidePrivateKey]);

  const showPrivateKey = () => {
    clearAutoHideTimer();
    dispatch({ type: "show" });
    autoHideTimerRef.current = schedulePrivateKeyAutoHide(
      (callback, delayMs) => setTimeout(callback, delayMs),
      () => {
        if (mountedRef.current) dispatch({ type: "hide" });
        autoHideTimerRef.current = null;
      },
    );
  };

  const copyPrivateKey = async () => {
    if (copyPendingRef.current) return;
    copyPendingRef.current = true;
    clearCopyStatusTimer();

    const writeText = navigator.clipboard?.writeText?.bind(
      navigator.clipboard,
    );
    const result = writeText
      ? await copyPrivateKeyToClipboard(account.privateKey, writeText)
      : "error";

    copyPendingRef.current = false;
    if (!mountedRef.current) return;
    dispatch({
      type: result === "copied" ? "copy-succeeded" : "copy-failed",
    });
    copyStatusTimerRef.current = setTimeout(() => {
      if (mountedRef.current) dispatch({ type: "clear-copy-status" });
      copyStatusTimerRef.current = null;
    }, PRIVATE_KEY_COPY_STATUS_MS);
  };

  const continueToWorkspace = async () => {
    if (!state.acknowledged || continuePending) return;
    setContinuePending(true);
    setContinueError(null);
    hidePrivateKey();
    clearCopyStatusTimer();
    if (displayRef.current) displayRef.current.textContent = "";
    const completed = await onContinue();
    if (!mountedRef.current) return;
    if (completed) {
      dispatch({ type: "continue" });
      return;
    }
    setContinuePending(false);
    setContinueError(
      "Unable to finish wallet setup securely. Try Continue again.",
    );
  };

  const displayValue = state.revealed
    ? bytesToHex(account.privateKey)
    : PRIVATE_KEY_MASK;

  return (
    <div className="pc">
      <div className="pc-root">
        <div className="pc-bg" aria-hidden="true">
          <div className="pc-bg-tr" />
          <div className="pc-bg-bl" />
          <div className="pc-bg-c" />
          <div className="pc-bg-vignette" />
        </div>

        <main
          className="pc-workspace"
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 24,
          }}
        >
          <section
            className="pc-panel pc-panel-elevated pc-anim-bottom"
            aria-labelledby="one-time-private-key-title"
            style={{ width: "min(100%, 720px)", zIndex: 1 }}
          >
            <p className="pc-hero-eyebrow">One-time wallet backup</p>
            <h1
              id="one-time-private-key-title"
              style={{
                margin: "8px 0 12px",
                color: "#FFF9F5",
                fontSize: 30,
              }}
            >
              Save your private key
            </h1>

            <div
              role="alert"
              style={{
                marginBottom: 22,
                padding: "14px 16px",
                borderRadius: 10,
                border: "1px solid rgba(255, 113, 89, 0.45)",
                background:
                  "linear-gradient(135deg, rgba(196, 57, 38, 0.18), rgba(244, 122, 60, 0.08))",
                color: "#FFD5CA",
                lineHeight: 1.55,
              }}
            >
              Anyone with this private key can control this wallet. Never share
              it or include it in a screenshot.
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 10,
                marginBottom: 8,
              }}
            >
              <label
                className="pc-label"
                htmlFor="one-time-private-key"
                style={{ margin: 0 }}
              >
                Private key
              </label>
              <button
                type="button"
                className="pc-btn-secondary"
                aria-label={
                  state.revealed
                    ? "Hide private key"
                    : "Reveal private key"
                }
                aria-pressed={state.revealed}
                onClick={state.revealed ? hidePrivateKey : showPrivateKey}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  minHeight: 32,
                  padding: "6px 10px",
                  fontSize: 12,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                {state.revealed ? <EyeOffIcon /> : <EyeIcon />}
                <span>{state.revealed ? "Hide" : "Reveal"}</span>
              </button>
            </div>
            <code
              ref={displayRef}
              id="one-time-private-key"
              role="textbox"
              aria-readonly="true"
              aria-label={
                state.revealed
                  ? "Private key visible"
                  : "Private key hidden"
              }
              className="pc-input"
              style={{
                display: "block",
                minHeight: 48,
                overflowWrap: "anywhere",
                letterSpacing: state.revealed ? "0.02em" : "0.08em",
                lineHeight: 1.7,
              }}
            >
              {displayValue}
            </code>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                marginTop: 14,
              }}
            >
              <button
                type="button"
                className="pc-btn-secondary"
                onClick={() => void copyPrivateKey()}
              >
                Copy private key
              </button>
            </div>

            <div aria-live="polite" style={{ minHeight: 28, marginTop: 10 }}>
              {state.copyStatus === "copied" && (
                <p style={{ margin: 0, color: "#72D69A", fontSize: 13 }}>
                  {PRIVATE_KEY_COPY_SUCCESS_MESSAGE}
                </p>
              )}
              {state.copyStatus === "error" && (
                <p role="alert" style={{ margin: 0, color: "#ff8d8d", fontSize: 13 }}>
                  {PRIVATE_KEY_COPY_ERROR_MESSAGE}
                </p>
              )}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginTop: 12,
                color: "#CEBAB0",
                lineHeight: 1.5,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={state.acknowledged}
                onChange={(event) =>
                  dispatch({
                    type: "acknowledge",
                    value: event.target.checked,
                  })
                }
                style={{ marginTop: 3 }}
              />
              <span>I have saved my private key safely.</span>
            </label>

            <p style={{ color: "#9D8982", fontSize: 12, lineHeight: 1.55 }}>
              Create a password-protected encrypted payload inside the JSON
              backup. The file will also contain the required visible
              plaintext privateKey field.
            </p>

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="pc-btn-secondary"
                onClick={() => setBackupOpen(true)}
              >
                {backupDownloaded
                  ? "Download another JSON backup"
                  : "Create JSON backup"}
              </button>
              {backupDownloaded && (
                <p
                  role="status"
                  style={{ margin: "8px 0 0", color: "#72D69A", fontSize: 13 }}
                >
                  JSON backup download started.
                </p>
              )}
            </div>

            {continueError && (
              <p
                role="alert"
                style={{ margin: "14px 0 0", color: "#ff8d8d", fontSize: 13 }}
              >
                {continueError}
              </p>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 20,
              }}
            >
              <button
                type="button"
                className="pc-btn-primary"
                disabled={!state.acknowledged || continuePending}
                onClick={() => void continueToWorkspace()}
                style={
                  !state.acknowledged || continuePending
                    ? {
                        opacity: 0.48,
                        cursor: "not-allowed",
                        transform: "none",
                      }
                    : undefined
                }
              >
                {continuePending ? "Finishing..." : "Continue"}
              </button>
            </div>
          </section>
        </main>
        {backupOpen && (
          <WalletBackupDialog
            account={account}
            onClose={() => setBackupOpen(false)}
            onExported={() => setBackupDownloaded(true)}
          />
        )}
      </div>
    </div>
  );
}
