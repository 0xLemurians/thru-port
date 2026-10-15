import React, { useState, useEffect, useRef } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkHealth } from "./useNetworkHealth";
import { useTokenPortfolio, useTokenSendSources, type TokenPortfolioHook } from "@/lib/token/portfolio-hook";
import { formatRawAmount } from "@thru/programs/token";
import { useTokenTransfer } from "@/lib/token/useTokenTransfer";
import { decimalAmountToRaw } from "@/lib/token/validation";
import {
  type TokenPortfolioItem,
  type TransferTokenResult,
} from "@/lib/token/thru-token";
import { tokenDisplayLabels, tokenReadBalance, tokenSendSourceAllowed, tokenSourceRestriction } from "@/lib/token/portfolio";
import TokenDiscoveryStatus from "../token-studio/TokenDiscoveryStatus";
import TokenSourcePicker from "../token-studio/TokenSourcePicker";
import WalletBackupDialog from "./WalletBackupDialog";
import type { WalletPortfolio } from "@/lib/portfolio/asset-model";
import { portfolioForView, portfolioItemsForView, portfolioViewKey } from "@/lib/portfolio/presentation";
import { NativeAssetSummary, PortfolioAssetList } from "../command/PortfolioAssets";
import { explorerTransactionUrl } from "@/lib/thru/network";
import NativeSendForm, { NativeTransferStatus } from "../command/NativeSendForm";
import { useNativeTransfer } from "../command/NativeTransferProvider";
import { NATIVE_ASSET_VALUE, nativeSendBusy } from "@/lib/wallet/native-transfer-controller";
import SendAssetPicker from "../command/SendAssetPicker";
import commandStyles from "../command/command.module.css";

interface PortWalletPopoverProps {
  id: string;
  account: ThruAccount;
  balance: bigint | null;
  health: NetworkHealth;
  onForgetAccount?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  align?: "left" | "right";
  portfolioHook?: TokenPortfolioHook;
  portfolioModel?: WalletPortfolio | null;
}

export default function PortWalletPopover(props: PortWalletPopoverProps) {
  const key = portfolioViewKey(props.account.address);
  return props.portfolioHook
    ? <SharedWalletPopover key={key} {...props} portfolioHook={props.portfolioHook} />
    : <StandaloneWalletPopover key={key} {...props} />;
}

// Legacy PortHeader only. This boundary mounts on demand; the active Dashboard
// supplies AppFlow's hook and never mounts another discovery lifecycle.
function StandaloneWalletPopover(props: PortWalletPopoverProps) {
  const portfolioHook = useTokenPortfolio(props.account, { networkStatus: props.health.status });
  return <SharedWalletPopover {...props} portfolioHook={portfolioHook} />;
}

function SharedWalletPopover({
  id,
  account,
  balance,
  health,
  onForgetAccount,
  onBusyChange,
  align = "right",
  portfolioHook,
  portfolioModel,
}: PortWalletPopoverProps & { portfolioHook: TokenPortfolioHook }) {
  const [activeTab, setActiveTab] = useState<"none" | "send" | "receive">("none");
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const { state: nativeState, controller: nativeController } = useNativeTransfer();
  const nativeBusy = nativeState ? nativeSendBusy(nativeState) : false;

  useEffect(() => {
    setDisconnectConfirm(false);
    setRemoveError(null);
    setRemoving(false);
    setBackupOpen(false);
  }, [account?.address]);

  const handleConfirmRemoval = async () => {
    if (removing || nativeBusy || !onForgetAccount) return;
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

  const model = portfolioForView(account.address, portfolioHook, health.status, balance, portfolioModel);
  const isLoading = !portfolioHook.storageReady || portfolioHook.refreshing;

  // Wallet holdings and created/controlled records are both visible, separately labeled.
  const ownedPortfolio = portfolioItemsForView(portfolioHook, model);

  // Lifted state
  const [selectedMint, setSelectedMint] = useState<string>("");

  // Set initial selected mint if not set
  useEffect(() => {
    if (!selectedMint && ownedPortfolio.length > 0) {
      setSelectedMint(ownedPortfolio[0].mintAddress);
    }
  }, [selectedMint, ownedPortfolio]);
  useEffect(() => {
    if (selectedMint && selectedMint !== NATIVE_ASSET_VALUE && !model.tokens.some((item) => item.mintAddress === selectedMint)) setSelectedMint("");
  }, [model.tokens, selectedMint]);

  // Click outside and escape handling
  const popoverRef = useRef<HTMLDivElement>(null);

  // We only close if not busy
  const { busy, progressLabel, error, result, transfer, resetState } = useTokenTransfer({
    account,
    onSuccess: () => portfolioHook.refreshRecords(portfolioHook.records),
  });

  useEffect(() => {
    onBusyChange?.(busy || nativeBusy || removing);
    return () => onBusyChange?.(false);
  }, [busy, nativeBusy, onBusyChange, removing]);


  return (
    <div
      id={id}
      ref={popoverRef}
      className="pc-wallet-popover"
      role="dialog"
      aria-label="Wallet actions"
      aria-busy={busy || nativeBusy}
      tabIndex={-1}
      style={{
        position: "absolute",
        top: "40px",
        ...(align === "left" ? { left: 0 } : { right: 0 }),
        width: "320px",
        // Left-aligned Dashboard anchors sit inside workspace + panel padding.
        // Keep a narrow-screen gutter instead of clipping the right-hand controls.
        maxWidth: align === "left" ? "calc(100vw - 80px)" : "calc(100vw - 32px)",
        maxHeight: "80vh",
        backgroundColor: "var(--bg)",
        backgroundImage: "linear-gradient(var(--surface), var(--surface))",
        color: "var(--text-main)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        boxShadow: "0 18px 50px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,123,66,0.08)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Main wallet</span>
          <span style={{ color: "#3DDC97", fontSize: "10px", fontWeight: 500, textTransform: "none" }}>Saved on this device</span>
        </div>
        <NativeAssetSummary asset={model.native} />

        <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
          <button
            type="button"
            className={`pc-btn-primary ${activeTab === "send" ? "active" : ""}`}
            style={{ flex: 1, padding: "6px 12px", fontSize: "13px" }}
            onClick={() => setActiveTab("send")}
            disabled={busy}
          >
            Send
          </button>
          <button
            type="button"
            className={`pc-btn-secondary ${activeTab === "receive" ? "active" : ""}`}
            style={{ flex: 1, padding: "6px 12px", fontSize: "13px" }}
            onClick={() => setActiveTab("receive")}
            disabled={busy}
          >
            Receive
          </button>
        </div>
      </div>

      {activeTab === "send" && (
        <div style={{ flex: "none" }}>
          <div style={{ padding: "12px 16px" }}>
            <SendAssetPicker value={selectedMint} disabled={busy || nativeBusy} onChange={setSelectedMint}
              options={ownedPortfolio.map((item) => ({ value: item.mintAddress, label: tokenDisplayLabels(item.label, item.mint?.ticker).primary }))} />
          </div>
          {selectedMint === NATIVE_ASSET_VALUE ? <div style={{ padding: "0 16px 16px" }}><NativeSendForm /></div> :
          <PopoverSend
            account={account}
            portfolio={ownedPortfolio}
            health={health}
            busy={busy || nativeBusy}
            progressLabel={progressLabel}
            error={error}
            result={result}
            transfer={transfer}
            resetState={resetState}
            selectedMint={selectedMint}
            setSelectedMint={setSelectedMint}
          />}
          {selectedMint !== NATIVE_ASSET_VALUE && nativeState && nativeController && nativeState.phase !== "idle" &&
            <NativeTransferStatus state={nativeState} onReconcile={() => void nativeController.reconcile()} />}
        </div>
      )}

      {activeTab === "receive" && (
        <div style={{ flex: "none" }}>
          <PopoverReceive account={account} portfolio={ownedPortfolio} />
        </div>
      )}

      {/* Always show tokens list at the bottom */}
      <div style={{ padding: "16px", backgroundColor: "var(--bg-card)", maxHeight: "200px", overflowY: "auto" }}>
        <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
          Tokens
        </div>
        {isLoading && ownedPortfolio.length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--text-dim)" }}>Loading tokens...</div>
        )}

        {isLoading && ownedPortfolio.length > 0 && (
          <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "4px", opacity: 0.7 }}>Refreshing...</div>
        )}

        <PortfolioAssetList model={model} disabled={busy || nativeBusy} onSelect={(mint) => {
          if (busy || nativeBusy) return;
          setActiveTab("send"); resetState(); setSelectedMint(mint);
        }} />

        <TokenDiscoveryStatus portfolio={portfolioHook} status={health.status} model={model} />
        <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--border)", display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="pc-btn-secondary"
            style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center" }}
            onClick={() => setBackupOpen(true)}
            disabled={busy || nativeBusy}
          >
            Download Backup
          </button>
          {onForgetAccount && (!disconnectConfirm ? (
            <button
              type="button"
              className="pc-btn-secondary"
              style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center" }}
              disabled={busy || nativeBusy || removing}
              onClick={() => {
                if (busy || nativeBusy) return;
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
                style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center", color: "#ff8d8d", borderColor: "rgba(255,141,141,0.2)" }}
                disabled={removing || busy || nativeBusy}
                onClick={handleConfirmRemoval}
              >
                {removing ? "Removing..." : "Confirm removal"}
              </button>
              <button
                type="button"
                className="pc-btn-secondary"
                style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center" }}
                disabled={removing}
                onClick={() => {
                  setDisconnectConfirm(false);
                  setRemoveError(null);
                }}
              >
                Cancel
              </button>
            </>
          ))}
        </div>
        {disconnectConfirm && (
          <div style={{ marginTop: "6px", color: "#ff8d8d", fontSize: "11px", textAlign: "center" }}>
            {removeError ? removeError : "This removes the saved wallet from this browser. Make sure you have your JSON backup."}
          </div>
        )}
      </div>
      {backupOpen && (
        <WalletBackupDialog
          account={account}
          onClose={() => setBackupOpen(false)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// SEND FORM
// -----------------------------------------------------------------------------
function PopoverSend({
  account,
  portfolio,
  health,
  busy,
  progressLabel,
  error,
  result,
  transfer,
  resetState,
  selectedMint,
  setSelectedMint
}: {
  account: ThruAccount;
  portfolio: TokenPortfolioItem[];
  health: NetworkHealth;
  busy: boolean;
  progressLabel: string | null;
  error: string | null;
  result: TransferTokenResult | null;
  transfer: (args: {
    selectedTokenMint: string;
    transferSource: string;
    transferDestination: string;
    transferAmount: string;
  }) => Promise<void>;
  resetState: () => void;
  selectedMint: string;
  setSelectedMint: (val: string) => void;
}) {
  const [dest, setDest] = useState("");
  const [amt, setAmt] = useState("");
  const [sourceChoice, setSourceChoice] = useState("");
  const [valError, setValError] = useState<string | null>(null);

  // When selected token changes via props, reset inputs
  useEffect(() => {
    setDest("");
    setAmt("");
    setSourceChoice("");
    resetState();
  }, [selectedMint, resetState]);

  const selectedItem = portfolio.find(p => p.mintAddress === selectedMint);
  const sources = useTokenSendSources(selectedItem, account.address);
  const activeAcc = sourceChoice ? sources.find((source) => source.address === sourceChoice) : sources[0];
  const previousSource = useRef(activeAcc?.address);
  useEffect(() => {
    if (previousSource.current !== activeAcc?.address) setAmt("");
    if (sourceChoice && !activeAcc) { setSourceChoice(""); setAmt(""); }
    previousSource.current = activeAcc?.address;
  }, [activeAcc, sourceChoice]);

  useEffect(() => {
    setValError(null);
    if (!amt.trim() || !activeAcc || !selectedItem?.mint) return;
    try {
      const raw = decimalAmountToRaw(amt, selectedItem.mint.decimals, undefined, "Amount");
      if (raw > (activeAcc.state?.amount ?? 0n)) {
        setValError("Insufficient balance.");
      }
    } catch (e) {
      setValError(e instanceof Error ? e.message : "Invalid amount");
    }
  }, [amt, activeAcc, selectedItem]);

  const healthDisabled = health.status === "Offline" || health.status === "Checking";
  const canSend = Boolean(selectedMint && dest && amt.trim() && activeAcc && previousSource.current === activeAcc.address && !busy && !valError && !healthDisabled);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || !activeAcc || !tokenSendSourceAllowed(selectedItem, account.address, activeAcc.address)) return;
    await transfer({
      selectedTokenMint: selectedMint,
      transferSource: activeAcc.address,
      transferDestination: dest,
      transferAmount: amt
    });
    setAmt("");
  };

  return (
    <div style={{ padding: "16px", borderBottom: "1px solid var(--border)", backgroundColor: "var(--bg-card-alt)" }}>
      <form onSubmit={handleSend} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <TokenSourcePicker item={selectedItem} wallet={account.address} value={sourceChoice} disabled={busy}
          onChange={(address) => { setSourceChoice(address); setAmt(""); resetState(); }} />
        {tokenSourceRestriction(selectedItem, account.address) && <p role="status">{tokenSourceRestriction(selectedItem, account.address)}</p>}
        {activeAcc?.state && selectedItem?.mint && <p>Selected source balance: {formatRawAmount(activeAcc.state.amount, selectedItem.mint.decimals)} {selectedItem.mint.ticker}</p>}

        <label className="form-field">
          <span className={commandStyles.inputLabel}>Token</span>
          <select
            className={commandStyles.inputSelect}
            value={selectedMint}
            onChange={e => {
              setSelectedMint(e.target.value);
              resetState();
            }}
            disabled={busy || portfolio.length === 0}
            style={{ padding: "6px" }}
          >
            {portfolio.length === 0 && <option value="">No tokens</option>}
            {portfolio.map(p => {
              const ticker = p.mint?.ticker ?? "TOKEN";
              const labels = tokenDisplayLabels(p.label, p.mint?.ticker);
              const bal = tokenReadBalance(p, account.address);
              return (
                <option key={p.mintAddress} value={p.mintAddress}>
                  {labels.primary}{labels.secondary ? ` (${labels.secondary})` : ""} — {bal} {ticker}
                </option>
              );
            })}
          </select>
        </label>

        <label className="form-field">
          <span className={commandStyles.inputLabel}>Recipient THRU address</span>
          <input
            className={`${commandStyles.inputText} mono`}
            value={dest}
            onChange={e => setDest(e.target.value)}
            disabled={busy}
            placeholder="ta..."
            spellCheck={false}
            autoComplete="off"
            style={{ padding: "6px", fontSize: "12px" }}
          />
        </label>

        <label className="form-field">
          <span className={commandStyles.inputLabel}>Amount</span>
          <input
            className={`${commandStyles.inputText} mono`}
            type="text"
            inputMode="decimal"
            value={amt}
            onChange={e => setAmt(e.target.value)}
            disabled={busy}
            placeholder="0.00"
            spellCheck={false}
            autoComplete="off"
            style={{ padding: "6px", fontSize: "12px" }}
          />
          {valError && <span role="alert" style={{ color: "var(--accent-red)", fontSize: "11px", marginTop: "2px" }}>{valError}</span>}
        </label>

        <button
          className="pc-btn-primary"
          type="submit"
          disabled={busy || !canSend}
          style={{ width: "100%", padding: "8px", marginTop: "4px" }}
        >
          {busy ? (progressLabel || "Sending...") : "Send Token"}
        </button>
      </form>

      {(error || result) && (
        <div style={{ marginTop: "12px", fontSize: "12px" }}>
          {error && <p role="alert" style={{ color: "var(--accent-red)", margin: 0 }}>{error}</p>}
          {result && (
            <div role="status">
              <p style={{ color: "var(--accent-green)", margin: 0 }}>Transfer successful!</p>
              <a href={explorerTransactionUrl(result.signature)} target="_blank" rel="noreferrer" style={{ color: "var(--accent-amber)" }}>
                View Explorer ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// RECEIVE VIEW
// -----------------------------------------------------------------------------
function PopoverReceive({
  account,
  portfolio
}: {
  account: ThruAccount;
  portfolio: TokenPortfolioItem[];
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopy = async (text: string, id: string) => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(null);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      setCopied(null);
      setCopyError("Unable to copy the public address.");
    }
  };

  return (
    <div style={{ padding: "16px", borderBottom: "1px solid var(--border)", backgroundColor: "var(--bg-card-alt)", fontSize: "13px" }}>
      <p style={{ color: "var(--text-dim)", marginBottom: "12px", marginTop: 0 }}>
        Share your wallet address for wallet-based transfers.
      </p>
      {copyError && <p role="alert" style={{ color: "var(--accent-red)" }}>{copyError}</p>}

      <div style={{ marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase" }}>Main Wallet Address</div>
        <div className="mono" style={{ fontSize: "12px", wordBreak: "break-all", color: "var(--text)", marginTop: "4px" }}>
          {account.address}
        </div>
        <button
          type="button"
          className="pc-btn-secondary"
          onClick={() => handleCopy(account.address, "main")}
          style={{ padding: "4px 8px", fontSize: "11px", marginTop: "6px" }}
        >
          {copied === "main" ? "Copied!" : "Copy address"}
        </button>
      </div>

      {portfolio.length > 0 && (
        <div>
          <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase", marginBottom: "8px" }}>Token Accounts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {portfolio.map(p => {
              const ticker = p.mint?.ticker ?? "TOKEN";
              const labels = tokenDisplayLabels(p.label, p.mint?.ticker);
              const acc = p.tokenAccounts.find(a => a.state?.owner === account.address);
              if (!acc) return null;
              const bal = acc.state && p.mint ? (acc.discoveryRead === "cached" ? "Cached: " : "") + formatRawAmount(acc.state.amount, p.mint.decimals) : "Unavailable";

              return (
                <div key={p.mintAddress} style={{ backgroundColor: "var(--bg)", padding: "8px", borderRadius: "4px" }}>
                  <div style={{ fontWeight: 500 }}>{labels.primary}</div>
                  {labels.secondary && (
                    <div className="mono" style={{ fontSize: "11px", color: "var(--text-dim)" }}>
                      {labels.secondary}
                    </div>
                  )}
                  <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>Balance: {bal} {ticker}</div>
                  <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "4px" }}>Token account: {acc.address.slice(0,8)}...</div>
                  <button
                    type="button"
                    className="pc-btn-secondary"
                    onClick={() => handleCopy(acc.address, p.mintAddress)}
                    style={{ padding: "2px 6px", fontSize: "10px", marginTop: "6px" }}
                  >
                    {copied === p.mintAddress ? "Copied!" : "Copy"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
