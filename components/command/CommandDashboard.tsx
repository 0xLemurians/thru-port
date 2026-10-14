"use client";

import React, { useState, useEffect, useMemo } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

import type { NetworkHealth } from "../port/useNetworkHealth";
import PortFaucetPanel from "../port/PortFaucetPanel";
import WalletBackupDialog from "../port/WalletBackupDialog";
import { clearSecretInputs } from "@/lib/wallet/wallet-backup";
import styles from "./command.module.css";
import type { TokenPortfolioHook } from "@/lib/token/portfolio-hook";
import { formatRawAmount } from "@thru/programs/token";
import { useTokenTransfer } from "@/lib/token/useTokenTransfer";
import { decimalAmountToRaw } from "@/lib/token/validation";
import { safeTokenActionError } from "@/lib/token/network-state";
import { THRU_NETWORK } from "@/lib/thru/network";
import CommandActivity from "./CommandActivity";
import NativeSendForm, { NativeTransferStatus } from "./NativeSendForm";
import { useNativeTransfer } from "./NativeTransferProvider";
import { NATIVE_ASSET_VALUE, nativeSendBusy } from "@/lib/wallet/native-transfer-controller";
import PortWalletPopover from "../port/PortWalletPopover";
import SendAssetPicker from "./SendAssetPicker";
import TokenDiscoveryStatus from "../token-studio/TokenDiscoveryStatus";
import TokenSourcePicker from "../token-studio/TokenSourcePicker";
import { tokenReadBalance, tokenSendSourceAllowed, tokenSourceRestriction } from "@/lib/token/portfolio";
import { useTokenSendSources } from "@/lib/token/portfolio-hook";

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
  health: NetworkHealth;
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
  const [walletActionsOpen, setWalletActionsOpen] = useState(false);
  const walletActionsRef = React.useRef<HTMLDivElement>(null);
  const walletTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [popoverBusy, setPopoverBusy] = useState(false);
  const { state: nativeState, controller: nativeController } = useNativeTransfer();
  const nativeBusy = nativeState ? nativeSendBusy(nativeState) : false;

  useEffect(() => {
    setWalletActionsOpen(false);
  }, [account?.address]);
  useEffect(() => {
    if (!walletActionsOpen) return;
    const close = () => {
      if (popoverBusy) return;
      setWalletActionsOpen(false);
      walletTriggerRef.current?.focus();
    };
    const key = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") close();
    };
    const outside = (event: MouseEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.target instanceof Node && !walletActionsRef.current?.contains(event.target)) close();
    };
    document.getElementById("command-wallet-actions")?.focus();
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mousedown", outside); };
  }, [walletActionsOpen, popoverBusy]);

  // Quick Send State
  const [selectedAssetMint, setSelectedAssetMint] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [sourceChoice, setSourceChoice] = useState("");
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

  const activeWalletAccounts = useTokenSendSources(selectedItem, account?.address ?? "");

  const selectedSourceAccount = activeWalletAccounts.find((source) => source.address === sourceChoice) ?? activeWalletAccounts[0];
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
    !validationError && !isHealthOffline && health?.status !== "Checking" && !nativeBusy
  );

  async function handleQuickSend(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !selectedAssetMint || !transferAllowed || !tokenSendSourceAllowed(selectedItem, account.address, transferSource)) return;
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
                  <span className={styles.networkName}>{THRU_NETWORK.displayName}</span>
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
              <h4 className={styles.blockTitle}>My Holdings / Created Tokens</h4>
              <TokenDiscoveryStatus portfolio={portfolioHook} status={health.status} />
              {portfolioHook.refreshing && portfolio.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Loading tokens...</div>
              ) : portfolio.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>No verified holdings or saved created tokens in this view. Discovery may be partial.</div>
              ) : (
                <div className={styles.tokenList}>
                  {portfolio.map((item) => {
                    const balanceFmt = tokenReadBalance(item, account.address);
                    return (
                      <div key={item.mintAddress} className={styles.tokenItem}>
                        <div className={styles.tokenLeft}>
                          <div className={styles.tokenSymbol}>{item.mint?.ticker ?? "TOKEN"}</div>
                          <div className={styles.tokenName}>{item.label || item.mintAddress.slice(0, 8) + "..."}</div>
                          <div className={styles.tokenName}>{item.mint?.creator === account.address || item.mint?.mintAuthority === account.address ? "Created / controlled" : "Holding"}
                            {item.discoveryRead === "cached" ? " · cached / stale" : ""}
                            {item.tokenAccounts.length > 1 ? " · multiple accounts; balance shown for one account" : ""}</div>
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

            <CommandActivity key={account.address} walletAddress={account.address} networkStatus={health.status} refreshRevision={nativeState?.revision ?? 0} />

            <div className={styles.gridBlockActions}>
              <h4 className={styles.blockTitle}>Quick Actions</h4>
              <SendAssetPicker value={selectedAssetMint} disabled={sendBusy || nativeBusy} onChange={(mint) => { setSelectedAssetMint(mint); setSourceChoice(""); setTransferAmount(""); }}
                options={portfolio.map((item) => {
                  return { value: item.mintAddress, label: `${item.mint?.ticker ?? "TOKEN"} — ${tokenReadBalance(item, account.address)}` };
                })} />
              {selectedAssetMint === NATIVE_ASSET_VALUE ? <NativeSendForm /> : <form className={styles.quickSend} onSubmit={handleQuickSend}>
                <TokenSourcePicker item={selectedItem} wallet={account.address} value={sourceChoice} disabled={sendBusy}
                  onChange={(address) => { setSourceChoice(address); setTransferAmount(""); }} />
                {tokenSourceRestriction(selectedItem, account.address) && <p role="status" className={styles.nativeHint}>{tokenSourceRestriction(selectedItem, account.address)}</p>}
                {selectedSourceAccount?.state && selectedItem?.mint && <p className={styles.nativeHint}>Selected source balance: {formatRawAmount(selectedSourceAccount.state.amount, selectedItem.mint.decimals)} {selectedItem.mint.ticker}</p>}
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
              </form>}
              {selectedAssetMint !== NATIVE_ASSET_VALUE && nativeState && nativeController && nativeState.phase !== "idle" &&
                <NativeTransferStatus state={nativeState} onReconcile={() => void nativeController.reconcile()} />}
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
               <div ref={walletActionsRef} className={styles.nativeWalletAnchor}>
                 <button type="button" ref={walletTriggerRef} className={styles.btnOutlineSmall} disabled={!account}
                   aria-haspopup="dialog" aria-expanded={walletActionsOpen} aria-controls="command-wallet-actions"
                   onClick={() => { if (!popoverBusy) setWalletActionsOpen(!walletActionsOpen); }}>Wallet actions</button>
                 {walletActionsOpen && account && <PortWalletPopover id="command-wallet-actions" align="left" account={account} balance={balance}
                   health={health} onForgetAccount={onForgetAccount} onBusyChange={setPopoverBusy} />}
               </div>
               <button type="button" className={styles.btnOutlineSmall} onClick={copyAddress} disabled={!account}>
                 {copied ? "Copied" : "Copy Address"}
               </button>
               <button type="button" className={styles.btnDangerGhostInline} onClick={onForgetAccount} disabled={!account || nativeBusy || sendBusy}>
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
                 accountAvailable={Boolean(account)}
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
