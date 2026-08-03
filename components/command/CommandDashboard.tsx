"use client";

import React, { useState, useEffect, useMemo } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

import type { AlphaNetHealth } from "../port/useAlphaNetHealth";
import PortFaucetPanel from "../port/PortFaucetPanel";
import WalletBackupDialog from "../port/WalletBackupDialog";
import { clearSecretInputs } from "@/lib/wallet/wallet-backup";
import styles from "./command.module.css";
import type { TokenPortfolioHook } from "@/lib/token/portfolio-hook";
import { formatRawAmount } from "@thru/programs/token";
import { useTokenTransfer } from "@/lib/token/useTokenTransfer";
import { decimalAmountToRaw } from "@/lib/token/validation";
import { safeTokenActionError } from "@/lib/token/network-state";

type WalletImportMode = "hidden" | "hex" | "backup";

interface CommandDashboardProps {
  account: ThruAccount | null;
  balance: bigint | null;
  balanceError: string | null;
  walletBusy: boolean;
  walletError: string | null;
  onCreateWallet: () => void | Promise<boolean>;
  onImportWallet: (kind: "hex", value: string) => Promise<boolean>;
  onImportBackup: (file: File, password: string) => Promise<boolean>;
  health: AlphaNetHealth;
  faucetState?: "idle" | "requesting" | "confirming" | "success" | "error";
  faucetError?: string | null;
  retryInfo?: string | null;
  lastSignature?: string | null;
  onRequestFaucet?: () => void;
  onCancelFaucet?: () => void;
  onForgetAccount?: () => void | Promise<void>;
  restoreStatus?: "RESTORING" | "WALLET_READY" | "NO_SAVED_WALLET" | "VAULT_ERROR";
  persistenceWarning?: string | null;
  portfolioHook: TokenPortfolioHook;
}

export default function CommandDashboard({
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
  portfolioHook,
}: CommandDashboardProps) {
  const [importMode, setImportMode] = useState<WalletImportMode>("hidden");
  const [importReady, setImportReady] = useState(false);
  const [backupFileReady, setBackupFileReady] = useState(false);
  const importSecretRef = React.useRef<HTMLTextAreaElement>(null);
  const backupPasswordRef = React.useRef<HTMLInputElement>(null);
  const backupFileRef = React.useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupAck, setBackupAck] = useState(false);

  // Quick Send State
  const [selectedAssetMint, setSelectedAssetMint] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const { portfolio } = portfolioHook;
  
  // Set default asset if none selected and portfolio has items
  useEffect(() => {
    if (account && portfolio.length > 0 && !selectedAssetMint) {
       setSelectedAssetMint(portfolio[0].mintAddress);
    }
  }, [portfolio, selectedAssetMint, account]);

  const { busy: sendBusy, progressLabel, error: sendError, result: sendResult, transfer } = useTokenTransfer({
    account,
    onSuccess: () => {
      // Refresh portfolio after a successful send
      portfolioHook.refreshRecords(portfolioHook.records);
    }
  });

  const selectedItem = useMemo(() => {
    return portfolio.find((p) => p.mintAddress === selectedAssetMint);
  }, [portfolio, selectedAssetMint]);

  const activeWalletAccounts = useMemo(() => {
    if (!account || !selectedItem) return [];
    return selectedItem.tokenAccounts.filter((acc) => acc.state?.owner === account.address);
  }, [account, selectedItem]);

  const selectedSourceAccount = activeWalletAccounts[0];
  const transferSource = selectedSourceAccount?.address || "";

  useEffect(() => {
    setValidationError(null);
    if (!transferAmount.trim() || !selectedSourceAccount || !selectedItem?.mint) return;
    try {
      const rawAmount = decimalAmountToRaw(transferAmount, selectedItem.mint.decimals, undefined, "Amount");
      if (rawAmount > (selectedSourceAccount.state?.amount ?? 0n)) {
        setValidationError("Insufficient token balance.");
      }
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : "Invalid amount");
    }
  }, [transferAmount, selectedSourceAccount, selectedItem]);

  const isHealthOffline = health?.status === "Offline";
  const transferAllowed = Boolean(
    account && selectedAssetMint && transferSource && transferDestination && transferAmount.trim() &&
    !validationError && !isHealthOffline
  );

  async function handleQuickSend(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !selectedAssetMint || !transferAllowed) return;
    await transfer({
      selectedTokenMint: selectedAssetMint,
      transferSource,
      transferDestination,
      transferAmount
    });
    setTransferAmount("");
  }

  // Handle Max Button
  function handleSetMax() {
    if (selectedSourceAccount?.state && selectedItem?.mint) {
      const maxDecimals = formatRawAmount(selectedSourceAccount.state.amount, selectedItem.mint.decimals);
      setTransferAmount(maxDecimals);
    }
  }


  const switchImportMode = (nextMode: WalletImportMode) => {
    clearSecretInputs(importSecretRef.current, backupPasswordRef.current, backupFileRef.current);
    setImportReady(false);
    setBackupFileReady(false);
    setImportMode(nextMode);
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (importMode === "hidden") return;

    if (importMode === "backup") {
      const file = backupFileRef.current?.files?.[0];
      let password = backupPasswordRef.current?.value ?? "";
      if (!file || !password) return;
      switchImportMode("hidden");
      try {
        await onImportBackup(file, password);
      } finally {
        password = "";
      }
      return;
    }

    let secret = importSecretRef.current?.value ?? "";
    if (!secret.trim()) return;
    const kind = importMode;
    switchImportMode("hidden");
    try {
      await onImportWallet(kind, secret);
    } finally {
      secret = "";
    }
  };

  const copyAddress = () => {
    if (!account) return;
    navigator.clipboard.writeText(account.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className={styles.workspaceTop}>
      {/* Center Main Workspace */}
      <main className={styles.mainCenter}>
        <div className={styles.heroPanel}>
          <div className={styles.heroGrid}></div>
          <div className={styles.heroGlow}></div>
          
          <div className={styles.heroContentWrapper}>
            <div className={styles.heroLeft}>
              <div className={styles.heroHeader}>
                <div className={styles.networkBadgeInline}>
                  <div className={styles.dot}></div>
                  <span className={styles.networkName}>AlphaNet</span>
                </div>
                {account ? (
                  <div className={styles.statusIndicator}>Workspace Unlocked</div>
                ) : (
                  <div className={styles.statusIndicator} style={{ color: "var(--text-muted)" }}>Workspace Locked</div>
                )}
              </div>

              {!account ? (
                <>
                  <div className={styles.heroContent}>
                    <h1 style={{ fontSize: "2.5rem", fontWeight: 700, margin: "0 0 1rem 0", color: "var(--text-main)", letterSpacing: "-0.02em" }}>
                      Create, test and explore on Thru
                    </h1>
                    <p style={{ color: "var(--text-muted)", fontSize: "1.125rem", margin: 0, maxWidth: "500px", lineHeight: 1.5 }}>
                      Generate or import a test account locally to unlock this workspace. 
                      Private keys remain encrypted on your device.
                    </p>
                  </div>

                  <div className={styles.heroActions}>
                    {walletBusy ? (
                      <div style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "8px" }}>
                        <div className="pc-spinner" /> Preparing workspace...
                      </div>
                    ) : restoreStatus === "RESTORING" ? (
                      <div style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "8px" }}>
                        <div className="pc-spinner" /> Restoring wallet...
                      </div>
                    ) : restoreStatus === "VAULT_ERROR" ? (
                      <div className={`${styles.alert} ${styles.alertInfo}`} style={{ backgroundColor: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)", color: "#ef4444" }}>
                        {walletError ?? "The saved wallet could not be opened on this device."}
                      </div>
                    ) : importMode !== "hidden" ? (
                      <form onSubmit={handleImportSubmit} style={{ width: "100%", maxWidth: "480px" }}>
                        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                          <button type="button" className={importMode === "hex" ? styles.btnPrimary : styles.btnSecondary} onClick={() => switchImportMode("hex")} style={{ flex: 1 }}>Private Key</button>
                          <button type="button" className={importMode === "backup" ? styles.btnPrimary : styles.btnSecondary} onClick={() => switchImportMode("backup")} style={{ flex: 1 }}>Backup File</button>
                        </div>
                        {importMode === "backup" ? (
                          <>
                            <input ref={backupFileRef} className={styles.inputText} type="file" accept=".json,application/json" onChange={(e) => setBackupFileReady(Boolean(e.target.files?.[0]))} style={{ marginBottom: "0.5rem" }} />
                            <input ref={backupPasswordRef} className={styles.inputText} type="password" placeholder="Backup password" onChange={(e) => setImportReady(e.target.value.length > 0)} style={{ marginBottom: "1rem" }} />
                          </>
                        ) : (
                          <textarea ref={importSecretRef} className={styles.inputText} placeholder="Enter your 64-character hex private key..." rows={3} onChange={(e) => setImportReady(e.target.value.trim().length > 0)} style={{ marginBottom: "1rem", resize: "none" }} />
                        )}
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button type="submit" className={styles.btnPrimary} disabled={!importReady || (importMode === "backup" && !backupFileReady)}>Confirm Import</button>
                          <button type="button" className={styles.btnSecondary} onClick={() => switchImportMode("hidden")}>Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <button type="button" className={styles.btnPrimary} onClick={onCreateWallet}>Create Wallet</button>
                        <button type="button" className={styles.btnSecondary} onClick={() => switchImportMode("hex")}>Import Wallet</button>
                      </>
                    )}
                    {walletError && restoreStatus !== "VAULT_ERROR" && (
                       <div style={{ width: "100%", color: "#ef4444", fontSize: "0.875rem", marginTop: "1rem" }}>{walletError}</div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.heroContent}>
                    <div className={styles.balanceLabel}>
                      Native Balance
                    </div>
                    <div className={styles.balanceAmount}>
                      {balanceError ? (
                        <span style={{ color: "var(--danger)", fontSize: "1.5rem" }}>Unavailable</span>
                      ) : balance === null ? (
                        <span style={{ fontSize: "1.5rem", color: "var(--text-muted)" }}>Loading...</span>
                      ) : (
                        <>
                           {balance.toString()} <span className={styles.balanceUnit}>native units</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={styles.heroActions}>
                    <button type="button" className={styles.btnPrimary} onClick={copyAddress}>↓ Receive</button>
                    <button type="button" className={styles.btnSecondary} disabled>⬡ Create Token</button>
                    <button type="button" className={styles.btnGhost} disabled>Open Tokens ↗</button>
                  </div>
                </>
              )}
            </div>

            <div className={styles.heroRightVis}>
              <div className={styles.visContainer}>
                <div className={styles.visRingOuter}></div>
                <div className={styles.visRingInner}></div>
                <div className={styles.visCenterNode}></div>
                <div className={styles.visOrbitingNode}></div>
                <div className={styles.visLabel}>SYS_ACTIVE</div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Modular Area (only visible if logged in) */}
        {account && (
          <div className={styles.bottomGrid} style={{ marginTop: "2rem" }}>
            <div className={styles.gridBlockTokens}>
              <h4 className={styles.blockTitle}>Your Tokens</h4>
              {portfolioHook.refreshing && portfolio.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading tokens...</div>
              ) : portfolio.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>No tokens found in portfolio.</div>
              ) : (
                <div className={styles.tokenList}>
                  {portfolio.map((item) => {
                    const balanceRaw = item.tokenAccounts.find(a => a.state?.owner === account.address)?.state?.amount ?? 0n;
                    const balanceFmt = item.mint ? formatRawAmount(balanceRaw, item.mint.decimals) : "0";
                    return (
                      <div key={item.mintAddress} className={styles.tokenItem}>
                        <div className={styles.tokenLeft}>
                          <div className={styles.tokenSymbol}>{item.mint?.ticker ?? "TOKEN"}</div>
                          <div className={styles.tokenName}>{item.label || item.mintAddress.slice(0, 8) + "..."}</div>
                        </div>
                        <div className={styles.tokenRight}>
                          <div className={styles.tokenBalance}>{balanceFmt}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={styles.gridBlockActivity}>
              <h4 className={styles.blockTitle}>Recent Activity</h4>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", display: "flex", alignItems: "center", justifyContent: "center", height: "60%" }}>
                No recent local activity yet.
              </div>
            </div>

            <div className={styles.gridBlockActions}>
              <h4 className={styles.blockTitle}>Quick Actions</h4>
              <form className={styles.quickSend} onSubmit={handleQuickSend}>
                <div className={styles.inputGroup}>
                  <label className={styles.inputLabel}>Asset</label>
                  <select 
                    className={styles.inputSelect} 
                    value={selectedAssetMint} 
                    onChange={e => setSelectedAssetMint(e.target.value)}
                    disabled={sendBusy}
                  >
                    {portfolio.map(item => {
                       const balanceRaw = item.tokenAccounts.find(a => a.state?.owner === account.address)?.state?.amount ?? 0n;
                       const balanceFmt = item.mint ? formatRawAmount(balanceRaw, item.mint.decimals) : "0";
                       return (
                         <option key={item.mintAddress} value={item.mintAddress}>
                           {item.mint?.ticker ?? "TOKEN"} - {balanceFmt}
                         </option>
                       );
                    })}
                    {portfolio.length === 0 && <option value="">No assets</option>}
                  </select>
                </div>
                <div className={styles.inputGroup}>
                  <label className={styles.inputLabel}>Recipient</label>
                  <input 
                    type="text" 
                    placeholder="thru1..." 
                    className={styles.inputText}
                    value={transferDestination}
                    onChange={e => setTransferDestination(e.target.value)}
                    disabled={sendBusy}
                    spellCheck={false}
                  />
                </div>
                <div className={styles.inputGroup}>
                  <label className={styles.inputLabel}>Amount</label>
                  <div className={styles.inputAmountWrapper}>
                    <input 
                      type="text" 
                      placeholder="0.00" 
                      className={styles.inputText}
                      value={transferAmount}
                      onChange={e => setTransferAmount(e.target.value)}
                      disabled={sendBusy}
                    />
                    <button type="button" className={styles.maxBtn} onClick={handleSetMax}>MAX</button>
                  </div>
                  {validationError && (
                    <span style={{ color: "var(--danger)", fontSize: "0.75rem", marginTop: "2px", display: "block" }}>{validationError}</span>
                  )}
                  {sendError && (
                    <span style={{ color: "var(--danger)", fontSize: "0.75rem", marginTop: "2px", display: "block" }}>{safeTokenActionError(sendError, "Failed")}</span>
                  )}
                  {sendResult && (
                    <span style={{ color: "var(--success)", fontSize: "0.75rem", marginTop: "2px", display: "block" }}>Success! {sendResult.signature.slice(0, 16)}...</span>
                  )}
                </div>
                <button type="submit" className={styles.btnPrimaryFull} disabled={sendBusy || !transferAllowed}>
                  {sendBusy ? (progressLabel || "Sending...") : "Review Send"}
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* Unified Right Control Panel */}
      <aside className={styles.controlPanel}>
        <div className={styles.unifiedPanel}>
          <div className={styles.panelSection}>
            <h3 className={styles.panelTitle}>Wallet & Network</h3>
            <div className={styles.dataRow}>
              <span className={styles.dataLabel}>Address</span>
              <span className={styles.dataValueMono}>{account ? account.address.slice(0, 10) + "..." + account.address.slice(-8) : "Not connected"}</span>
            </div>
            <div className={styles.dataRow}>
              <span className={styles.dataLabel}>RPC Status</span>
              <span className={styles.dataValueSuccess} style={{ color: health.status === "Online" ? "var(--success)" : health.status === "Offline" ? "var(--danger)" : "var(--accent)" }}>
                {health.status}
              </span>
            </div>
            <div className={styles.panelActionsInline}>
               <button type="button" className={styles.btnOutlineSmall} onClick={copyAddress} disabled={!account}>
                 {copied ? "Copied" : "Copy Address"}
               </button>
               <button type="button" className={styles.btnDangerGhostInline} onClick={onForgetAccount} disabled={!account}>
                 Remove
               </button>
            </div>
          </div>

          <div className={styles.panelDivider}></div>

          <div className={styles.panelSection}>
            <h3 className={styles.panelTitle}>Wallet Backup</h3>
            <p className={styles.panelTextMedium}>
              Encrypted keystore backup. Contains your private key. Never share this file.
            </p>
            <div className={styles.checkboxGroup}>
              <input 
                type="checkbox" 
                id="backupAck" 
                checked={backupAck}
                onChange={(e) => setBackupAck(e.target.checked)}
                className={styles.checkbox}
                disabled={!account}
              />
              <label htmlFor="backupAck" className={styles.checkboxLabel}>
                I understand the security risks.
              </label>
            </div>
            <button type="button" className={styles.btnSecondaryFull} disabled={!backupAck || !account} onClick={() => setBackupOpen(true)}>
              Download Encrypted Backup
            </button>
          </div>

          <div className={styles.panelDivider}></div>

          <div className={styles.panelSection}>
             {/* We render PortFaucetPanel, but we need to ensure it looks okay inside the unified panel.
                 It has its own styling, but we might just want to use it directly. 
                 It's already functional. */}
            <div style={{ marginLeft: "-8px", marginRight: "-8px" }}>
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
          </div>
        </div>
      </aside>

      {account && backupOpen && (
        <WalletBackupDialog
          account={account}
          onClose={() => setBackupOpen(false)}
        />
      )}
    </div>
  );
}
