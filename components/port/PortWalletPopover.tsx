import React, { useState, useEffect, useRef, useMemo } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkHealth } from "./useNetworkHealth";
import { useTokenPortfolio } from "@/lib/token/portfolio-hook";
import { formatRawAmount } from "@thru/programs/token";
import { useTokenTransfer } from "@/lib/token/useTokenTransfer";
import { decimalAmountToRaw } from "@/lib/token/validation";
import {
  isCreatedTokenControlledByWallet,
  type TokenPortfolioItem,
  type TransferTokenResult,
} from "@/lib/token/thru-token";
import { tokenDisplayLabels } from "@/lib/token/portfolio";
import WalletBackupDialog from "./WalletBackupDialog";
import {
  formatNativeThruAmount,
  NATIVE_THRU_BALANCE_UNIT,
} from "@/lib/wallet/native-balance";
import { explorerTransactionUrl } from "@/lib/thru/network";

interface PortWalletPopoverProps {
  id: string;
  account: ThruAccount;
  balance: bigint | null;
  health: NetworkHealth;
  onForgetAccount?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

export default function PortWalletPopover({
  id,
  account,
  balance,
  health,
  onForgetAccount,
  onBusyChange,
}: PortWalletPopoverProps) {
  const [activeTab, setActiveTab] = useState<"none" | "send" | "receive">("none");
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);

  useEffect(() => {
    setDisconnectConfirm(false);
    setRemoveError(null);
    setRemoving(false);
    setBackupOpen(false);
  }, [account?.address]);

  const handleConfirmRemoval = async () => {
    if (removing || !onForgetAccount) return;
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

  const portfolioHook = useTokenPortfolio(account, {
    networkStatus: health.status,
  });
  const isLoading = !portfolioHook.storageReady || portfolioHook.refreshing;

  // Only tokens created by or currently controlled by this wallet.
  const ownedPortfolio = useMemo(() => {
    return portfolioHook.portfolio.filter((item) =>
      isCreatedTokenControlledByWallet(item, account.address),
    );
  }, [portfolioHook.portfolio, account.address]);

  // Lifted state
  const [selectedMint, setSelectedMint] = useState<string>("");

  // Set initial selected mint if not set
  useEffect(() => {
    if (!selectedMint && ownedPortfolio.length > 0) {
      setSelectedMint(ownedPortfolio[0].mintAddress);
    }
  }, [selectedMint, ownedPortfolio]);

  // Click outside and escape handling
  const popoverRef = useRef<HTMLDivElement>(null);

  // We only close if not busy
  const { busy, progressLabel, error, result, transfer, resetState } = useTokenTransfer({
    account,
    onSuccess: () => portfolioHook.refreshRecords(portfolioHook.records),
  });

  useEffect(() => {
    onBusyChange?.(busy || removing);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange, removing]);


  const nativeBalStr =
    balance !== null ? formatNativeThruAmount(balance) : "...";

  return (
    <div
      id={id}
      ref={popoverRef}
      className="pc-wallet-popover"
      role="dialog"
      aria-label="Wallet actions"
      aria-busy={busy}
      tabIndex={-1}
      style={{
        position: "absolute",
        top: "40px",
        right: 0,
        width: "320px",
        backgroundColor: "rgba(25, 12, 16, 0.97)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        boxShadow: "0 18px 50px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,123,66,0.08)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: "11px", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Main wallet</span>
          <span style={{ color: "#3DDC97", fontSize: "10px", fontWeight: 500, textTransform: "none" }}>Saved on this device</span>
        </div>
        <div style={{ marginTop: "4px" }}>
          <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>Native balance</div>
          <div style={{ fontSize: "20px", fontWeight: "600", color: "var(--text)" }}>
            {nativeBalStr} {balance !== null ? NATIVE_THRU_BALANCE_UNIT : ""}
          </div>
        </div>

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
          <PopoverSend
            account={account}
            portfolio={ownedPortfolio}
            health={health}
            busy={busy}
            progressLabel={progressLabel}
            error={error}
            result={result}
            transfer={transfer}
            resetState={resetState}
            selectedMint={selectedMint}
            setSelectedMint={setSelectedMint}
          />
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

        {!isLoading && ownedPortfolio.length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--text-dim)" }}>No created tokens.</div>
        )}

        {isLoading && ownedPortfolio.length > 0 && (
          <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "4px", opacity: 0.7 }}>Refreshing...</div>
        )}

        {ownedPortfolio.map((item) => {
          const acc = item.tokenAccounts.find(a => a.state?.owner === account.address);
          const bal = acc?.state ? formatRawAmount(acc.state.amount, item.mint?.decimals ?? 0) : "0";
          const ticker = item.mint?.ticker ?? "TOKEN";
          const labels = tokenDisplayLabels(item.label, item.mint?.ticker);

          return (
            <button
              key={item.mintAddress}
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
                background: "none",
                border: "none",
                padding: "8px 0",
                cursor: busy ? "not-allowed" : "pointer",
                textAlign: "left",
                color: "var(--text)",
                borderBottom: "1px solid var(--border-light)"
              }}
              onClick={() => {
                if (busy) return;
                setActiveTab("send");
                resetState();
                setSelectedMint(item.mintAddress);
              }}
              disabled={busy}
            >
              <span>
                <span style={{ display: "block", fontWeight: 500, fontSize: "14px" }}>
                  {labels.primary}
                </span>
                {labels.secondary && (
                  <span className="mono" style={{ display: "block", fontSize: "11px", color: "var(--text-dim)" }}>
                    {labels.secondary}
                  </span>
                )}
              </span>
              <span style={{ fontSize: "14px" }} className="mono">{bal} {ticker}</span>
            </button>
          );
        })}

        <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--border)", display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="pc-btn-secondary"
            style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center" }}
            onClick={() => setBackupOpen(true)}
            disabled={busy}
          >
            Download Backup
          </button>
          {onForgetAccount && (!disconnectConfirm ? (
            <button
              type="button"
              className="pc-btn-secondary"
              style={{ flex: 1, padding: "6px", fontSize: "11px", justifyContent: "center" }}
              onClick={() => {
                if (busy) return;
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
                disabled={removing || busy}
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
  const [valError, setValError] = useState<string | null>(null);

  // When selected token changes via props, reset inputs
  useEffect(() => {
    setDest("");
    setAmt("");
    resetState();
  }, [selectedMint, resetState]);

  const selectedItem = portfolio.find(p => p.mintAddress === selectedMint);
  const activeAcc = selectedItem?.tokenAccounts.find(a => a.state?.owner === account.address);

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
  const canSend = Boolean(selectedMint && dest && amt.trim() && !valError && !healthDisabled);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || !activeAcc) return;
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

        <label className="form-field">
          <span className="field-label">Token</span>
          <select
            className="input"
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
              const acc = p.tokenAccounts.find(a => a.state?.owner === account.address);
              const bal = acc?.state ? formatRawAmount(acc.state.amount, p.mint?.decimals ?? 0) : "0";
              return (
                <option key={p.mintAddress} value={p.mintAddress}>
                  {labels.primary}{labels.secondary ? ` (${labels.secondary})` : ""} — {bal} {ticker}
                </option>
              );
            })}
          </select>
        </label>

        <label className="form-field">
          <span className="field-label">Recipient THRU address</span>
          <input
            className="input mono"
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
          <span className="field-label">Amount</span>
          <input
            className="input mono"
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
              const bal = acc.state ? formatRawAmount(acc.state.amount, p.mint?.decimals ?? 0) : "0";

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
