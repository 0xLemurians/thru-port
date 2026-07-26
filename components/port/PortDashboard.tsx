"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { clearSecretInputs } from "@/lib/wallet/wallet-backup";
import PortSafetyRail from "./PortSafetyRail";
import type { AlphaNetHealth } from "./useAlphaNetHealth";
import PortFaucetPanel from "./PortFaucetPanel";
import PortFooter from "./PortFooter";
import WalletBackupDialog from "./WalletBackupDialog";

type WalletImportMode = "hidden" | "hex" | "backup";

interface PortDashboardProps {
  account: ThruAccount | null;
  balance: bigint | null;
  balanceError: string | null;
  walletBusy: boolean;
  walletError: string | null;
  onCreateWallet: () => void | Promise<boolean>;
  onImportWallet: (
    kind: "hex",
    value: string,
  ) => Promise<boolean>;
  onImportBackup: (file: File, password: string) => Promise<boolean>;
  health: AlphaNetHealth;
  faucetState?: "idle" | "requesting" | "confirming" | "success" | "error";
  faucetError?: string | null;
  retryInfo?: string | null;
  lastSignature?: string | null;
  onRequestFaucet?: () => void;
  onCancelFaucet?: () => void;
  onForgetAccount?: () => void | Promise<void>;
  restoreStatus?:
    | "RESTORING"
    | "WALLET_READY"
    | "NO_SAVED_WALLET"
    | "VAULT_ERROR";
  persistenceWarning?: string | null;
}

export default function PortDashboard({
  account,
  balance,
  balanceError,
  walletBusy,
  walletError,
  onCreateWallet,
  onImportWallet,
  onImportBackup,
  health,
  faucetState = "idle",
  faucetError = null,
  retryInfo = null,
  lastSignature = null,
  onRequestFaucet = () => {},
  onCancelFaucet = () => {},
  onForgetAccount = () => {},
  restoreStatus = "NO_SAVED_WALLET",
  persistenceWarning = null,
}: PortDashboardProps) {
  const [importMode, setImportMode] = useState<WalletImportMode>("hidden");
  const [importReady, setImportReady] = useState(false);
  const [backupFileReady, setBackupFileReady] = useState(false);
  const importSecretRef = useRef<HTMLTextAreaElement>(null);
  const backupPasswordRef = useRef<HTMLInputElement>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);

  const clearImportSecretControls = useCallback(() => {
    clearSecretInputs(
      importSecretRef.current,
      backupPasswordRef.current,
      backupFileRef.current,
    );
  }, []);

  const resetImportForm = useCallback(() => {
    clearImportSecretControls();
    setImportReady(false);
    setBackupFileReady(false);
  }, [clearImportSecretControls]);

  const switchImportMode = (nextMode: WalletImportMode) => {
    resetImportForm();
    setImportMode(nextMode);
  };

  useEffect(() => {
    setDisconnectConfirm(false);
    setRemoveError(null);
    setRemoving(false);
    setBackupOpen(false);
    resetImportForm();
    setImportMode("hidden");
  }, [account?.address, resetImportForm]);

  useEffect(
    () => () => {
      clearImportSecretControls();
    },
    [clearImportSecretControls],
  );

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (importMode === "hidden") return;

    if (importMode === "backup") {
      const file = backupFileRef.current?.files?.[0];
      let password = backupPasswordRef.current?.value ?? "";
      if (!file || !password) return;
      resetImportForm();
      try {
        const imported = await onImportBackup(file, password);
        if (imported) setImportMode("hidden");
      } finally {
        password = "";
      }
      return;
    }

    let secret = importSecretRef.current?.value ?? "";
    if (!secret.trim()) return;
    const kind = importMode;
    resetImportForm();
    try {
      const imported = await onImportWallet(kind, secret);
      if (imported) setImportMode("hidden");
    } finally {
      secret = "";
    }
  };

  const copyAddress = () => {
    if (!account) return;
    setCopyError(false);
    navigator.clipboard.writeText(account.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 3000);
    });
  };

  const handleConfirmRemoval = async () => {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await onForgetAccount();
    } catch {
      setRemoveError(
        "Unable to remove the wallet from this device. Try again.",
      );
    } finally {
      setRemoving(false);
    }
  };

  const shortAddress = account
    ? `${account.address.slice(0, 8)}...${account.address.slice(-8)}`
    : "";

  return (
    <div className="pc-dash-layout">
      <div className="pc-dash-center">
        <div className="pc-dash-grid" style={{ width: "100%", margin: 0 }}>
          
          <div className="pc-hero">
            <div className="pc-anim-bottom" style={{ animationDelay: "0ms" }}>
              <p className="pc-hero-eyebrow">AlphaNet Workspace</p>
              
              {!account ? (
                <>
                  <h1 className="pc-hero-title">Create, test and explore on Thru</h1>
                  <p className="pc-hero-desc">
                    Generate or import a test account locally to unlock this workspace. 
                    Private keys remain encrypted on your device and can be removed at any time.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="pc-hero-title" style={{ color: "#3DDC97" }}>Workspace unlocked</h1>
                  <p className="pc-hero-desc">
                    Use the navigation above to continue to Tokens or Identity.
                  </p>
                </>
              )}
            </div>
            
            <div className="pc-hero-actions pc-anim-bottom" style={{ animationDelay: "60ms", minHeight: "44px" }}>
              {!account ? (
                walletBusy ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "#CEBAB0", fontSize: "14px", fontWeight: 500 }}>
                    <div className="pc-spinner" /> Preparing workspace...
                  </div>
                ) : restoreStatus === "RESTORING" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "#CEBAB0", fontSize: "14px", fontWeight: 500 }}>
                    <div className="pc-spinner" /> Restoring wallet...
                  </div>
                ) : restoreStatus === "VAULT_ERROR" ? (
                  <div
                    role="alert"
                    style={{
                      color: "#ff8d8d",
                      fontSize: 13,
                      background: "rgba(255, 141, 141, 0.08)",
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid rgba(255,141,141,0.2)",
                    }}
                  >
                    {walletError ??
                      "The saved wallet could not be opened on this device."}
                  </div>
                ) : importMode !== "hidden" ? (
                  <form className="pc-import-form pc-anim-bottom" onSubmit={handleImportSubmit} style={{ width: "100%", maxWidth: "480px" }}>
                    <div className="pc-tabs" style={{ marginBottom: 12 }}>
                      <button
                        type="button"
                        className={`pc-tab ${importMode === "hex" ? "active" : ""}`}
                        onClick={() => switchImportMode("hex")}
                      >
                        Private Key
                      </button>
                      <button
                        type="button"
                        className={`pc-tab ${importMode === "backup" ? "active" : ""}`}
                        onClick={() => switchImportMode("backup")}
                      >
                        Encrypted Backup
                      </button>
                    </div>
                    {importMode === "backup" ? (
                      <>
                        <label className="pc-label" htmlFor="wallet-backup-file">
                          Encrypted backup file
                        </label>
                        <input
                          ref={backupFileRef}
                          id="wallet-backup-file"
                          className="pc-input"
                          type="file"
                          accept=".json,application/json"
                          disabled={walletBusy}
                          onChange={(event) =>
                            setBackupFileReady(
                              Boolean(event.currentTarget.files?.[0]),
                            )
                          }
                          style={{ marginBottom: 12 }}
                        />
                        <label
                          className="pc-label"
                          htmlFor="wallet-backup-import-password"
                        >
                          Backup password
                        </label>
                        <input
                          ref={backupPasswordRef}
                          id="wallet-backup-import-password"
                          className="pc-input"
                          type="password"
                          autoComplete="current-password"
                          maxLength={1024}
                          disabled={walletBusy}
                          onChange={(event) =>
                            setImportReady(event.currentTarget.value.length > 0)
                          }
                          style={{ marginBottom: 12 }}
                        />
                      </>
                    ) : (
                      <textarea
                        ref={importSecretRef}
                        className="pc-input"
                        aria-label="Private key"
                        placeholder="Enter your 64-character hex private key..."
                        onChange={(event) =>
                          setImportReady(
                            event.currentTarget.value.trim().length > 0,
                          )
                        }
                        rows={3}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        disabled={walletBusy}
                        style={{ marginBottom: 12 }}
                      />
                    )}
                    <div style={{ display: "flex", gap: 12 }}>
                      <button 
                        type="submit" 
                        className="pc-btn-primary" 
                        disabled={
                          walletBusy ||
                          !importReady ||
                          (importMode === "backup" && !backupFileReady)
                        }
                      >
                        {walletBusy ? "Importing..." : "Confirm Import"}
                      </button>
                      <button 
                        type="button" 
                        className="pc-btn-secondary" 
                        onClick={() => switchImportMode("hidden")}
                        disabled={walletBusy}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <button type="button" className="pc-btn-primary" style={{ padding: "12px 24px", fontSize: "14px" }} onClick={onCreateWallet}>Create Wallet</button>
                    <button type="button" className="pc-btn-secondary" style={{ padding: "12px 24px", fontSize: "14px" }} onClick={() => switchImportMode("hex")}>Import Wallet</button>
                  </>
                )
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%", maxWidth: "480px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                    <div className="pc-anim-mask" style={{ display: "flex", alignItems: "center", gap: "8px", color: "#CEBAB0", fontSize: "14px", fontWeight: 500 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Wallet ready
                    </div>
                  </div>

                  <PortFaucetPanel
                    faucetState={faucetState}
                    faucetError={faucetError}
                    retryInfo={retryInfo}
                    lastSignature={lastSignature}
                    health={health}
                    onRequest={onRequestFaucet}
                    onCancel={onCancelFaucet}
                  />
                </div>
              )}
              {walletError && restoreStatus !== "VAULT_ERROR" && (
                <div className="pc-error pc-anim-bottom" style={{ marginTop: 16, color: "#ff8d8d", fontSize: 13, background: "rgba(255, 141, 141, 0.08)", padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(255,141,141,0.2)" }}>
                  {walletError}
                </div>
              )}
            </div>
          </div>

          <div className="pc-panel pc-anim-right" style={{ animationDelay: "100ms", position: "relative" }}>
            <div className="pc-thru-core" style={{ opacity: walletBusy ? 0.8 : 0.5 }}>
              <svg viewBox="0 0 200 200" width="100%" height="100%">
                 <circle cx="100" cy="100" r="60" fill="rgba(244,122,60,0.15)" filter="blur(20px)" />
                 <path className="pc-tc-ring-out" d="M 100 20 A 80 80 0 1 1 20 100" fill="none" stroke="rgba(216,161,93,0.3)" strokeWidth="1" />
                 <path className="pc-tc-ring-in" d="M 100 40 A 60 60 0 1 0 160 100" fill="none" stroke="rgba(244,122,60,0.3)" strokeWidth="1" />
                 <circle className="pc-tc-node" cx="100" cy="20" r="3" fill="#F47A3C" />
                 <circle className="pc-tc-node" cx="160" cy="100" r="2" fill="#D8A15D" />
                 <circle className="pc-tc-node" cx="20" cy="100" r="2" fill="#D8A15D" />
              </svg>
            </div>

            <div className="pc-section-title-wrap">
              <div className="pc-ember-line-h" style={{ width: account ? "32px" : "24px", transition: "width 600ms cubic-bezier(0.22, 1, 0.36, 1)" }} />
              <h2 className="pc-section-title">Wallet & Network</h2>
            </div>

            {!account ? (
              <>
                <div className="pc-info-row">
                  <span className="pc-info-key">Status</span>
                  <span className="pc-info-val">Not connected</span>
                </div>
                <div className="pc-info-row">
                  <span className="pc-info-key">Network</span>
                  <span className="pc-info-val">AlphaNet</span>
                </div>
                <div className="pc-info-row">
                  <span className="pc-info-key">RPC status</span>
                  <span className="pc-info-val" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" }}>
                    <span style={{
                      color: health.status === "Online" ? "#10b981" : health.status === "Offline" ? "#ef4444" : "#f59e0b"
                    }}>{health.status}</span>
                    {health.lastChecked && (
                      <span style={{ fontSize: "10px", color: "rgba(206, 186, 176, 0.4)" }}>
                        Last checked: {health.lastChecked}
                      </span>
                    )}
                  </span>
                </div>
                <div className="pc-info-row">
                  <span className="pc-info-key">Secret storage</span>
                  <span className="pc-info-val-mono" style={{ color: "#3DDC97" }}>Saved on this device</span>
                </div>
                <div className="pc-info-row" style={{ borderBottom: "none" }}>
                  <span className="pc-info-key">Saved public assets</span>
                  <span className="pc-info-val">—</span>
                </div>
              </>
            ) : (
              <>
                <div className="pc-info-row pc-anim-mask" style={{ animationDelay: "50ms" }}>
                  <span className="pc-info-key">Status</span>
                  <span className="pc-info-val" style={{ color: "#3DDC97" }}>Wallet ready</span>
                </div>
                <div className="pc-info-row pc-anim-bottom" style={{ animationDelay: "100ms" }}>
                  <span className="pc-info-key">Network</span>
                  <span className="pc-info-val">AlphaNet</span>
                </div>
                <div className="pc-info-row pc-anim-bottom" style={{ animationDelay: "125ms" }}>
                  <span className="pc-info-key">RPC status</span>
                  <span className="pc-info-val" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" }}>
                    <span style={{
                      color: health.status === "Online" ? "#10b981" : health.status === "Offline" ? "#ef4444" : "#f59e0b"
                    }}>{health.status}</span>
                    {health.lastChecked && (
                      <span style={{ fontSize: "10px", color: "rgba(206, 186, 176, 0.4)" }}>
                        Last checked: {health.lastChecked}
                      </span>
                    )}
                  </span>
                </div>
                <div className="pc-info-row pc-anim-bottom" style={{ animationDelay: "150ms" }}>
                  <span className="pc-info-key">Public address</span>
                  <span className="pc-info-val-mono">{shortAddress}</span>
                </div>
                <div className="pc-info-row pc-anim-bottom" style={{ borderBottom: balanceError ? "none" : undefined, animationDelay: "200ms" }}>
                  <span className="pc-info-key">Balance</span>
                  <span className="pc-info-val-mono">
                    {balanceError ? (
                      <span style={{ color: "#ff8d8d" }}>Unavailable</span>
                    ) : balance === null ? (
                      "Loading..."
                    ) : (
                      `${(Number(balance) / 1e18).toFixed(4)} THRU`
                    )}
                  </span>
                </div>
                {balanceError && (
                  <div className="pc-anim-mask" style={{
                    marginBottom: "16px",
                    padding: "10px 14px",
                    background: "rgba(255, 141, 141, 0.08)",
                    border: "1px solid rgba(255, 141, 141, 0.2)",
                    borderRadius: "6px",
                    color: "#ff8d8d",
                    fontSize: "12px",
                    lineHeight: "1.4"
                  }}>
                    {balanceError}
                  </div>
                )}
                <div className="pc-info-row pc-anim-bottom" style={{ borderBottom: "none", animationDelay: "250ms" }}>
                  <span className="pc-info-key">Secret storage</span>
                  <span className="pc-info-val-mono" style={{ color: "#3DDC97" }}>Saved on this device</span>
                </div>

                <div className="pc-anim-bottom" style={{ animationDelay: "300ms", display: "grid", gridTemplateColumns: disconnectConfirm ? "1fr auto 1fr 1fr" : "1fr auto 1fr", gap: "8px", marginTop: "24px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <button
                    type="button"
                    className="pc-btn-secondary"
                    style={{ padding: "8px", fontSize: "12px", gap: "6px", width: "100%", justifyContent: "center" }}
                    onClick={copyAddress}
                  >
                    {copied ? <span style={{ color: "#3DDC97" }}>✓ Copied</span> : copyError ? <span style={{ color: "#ff8d8d" }}>Error</span> : "Copy Address"}
                  </button>
                  <button
                    type="button"
                    className="pc-btn-secondary"
                    style={{ padding: "8px 12px", fontSize: "12px", gap: "6px", whiteSpace: "nowrap" }}
                    onClick={() => setBackupOpen(true)}
                  >
                    Download Backup
                  </button>
                  {!disconnectConfirm ? (
                    <button
                      type="button"
                      className="pc-btn-secondary"
                      style={{ padding: "8px", fontSize: "12px", gap: "6px", width: "100%", justifyContent: "center" }}
                      onClick={() => {
                        setDisconnectConfirm(true);
                        setRemoveError(null);
                      }}
                    >
                      Remove from device
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="pc-btn-secondary"
                        style={{ padding: "8px", fontSize: "12px", gap: "6px", width: "100%", justifyContent: "center", color: "#ff8d8d", borderColor: "rgba(255,141,141,0.2)" }}
                        disabled={removing}
                        onClick={handleConfirmRemoval}
                      >
                        {removing ? "Removing..." : "Confirm removal"}
                      </button>
                      <button
                        type="button"
                        className="pc-btn-secondary"
                        style={{ padding: "8px", fontSize: "12px", gap: "6px", width: "100%", justifyContent: "center" }}
                        disabled={removing}
                        onClick={() => {
                          setDisconnectConfirm(false);
                          setRemoveError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {disconnectConfirm && (
                  <div className="pc-anim-mask" style={{ color: "#ff8d8d", fontSize: "12px", marginTop: "8px", textAlign: "center" }}>
                    {removeError ? removeError : "This removes the saved wallet from this browser. Make sure you have your JSON backup."}
                  </div>
                )}
                {persistenceWarning && (
                  <div className="pc-anim-mask" style={{
                    marginTop: "12px",
                    padding: "10px 14px",
                    background: "rgba(245, 158, 11, 0.08)",
                    border: "1px solid rgba(245, 158, 11, 0.2)",
                    borderRadius: "6px",
                    color: "#f59e0b",
                    fontSize: "12px",
                    lineHeight: "1.4"
                  }}>
                    {persistenceWarning}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      
      <PortSafetyRail />
      <PortFooter />
      {account && backupOpen && (
        <WalletBackupDialog
          account={account}
          onClose={() => setBackupOpen(false)}
        />
      )}
    </div>
  );
}
