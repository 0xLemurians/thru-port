"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ThruAccount,
  createNewAccount,
  accountFromPrivateKey,
  getBalance,
  hexToBytes,
  explorerAddressUrl,
  explorerTransactionUrl,
  isAccountNotFoundError,
} from "@/lib/wallet/thru-wallet";
import { THRU_NETWORK } from "@/lib/thru/network";
import { clearSecretInputs } from "@/lib/wallet/wallet-backup";
import {
  withdrawFromFaucet,
  FAUCET_WITHDRAW_LIMIT,
} from "@/lib/wallet/faucet";
import {
  SAFE_FAUCET_ERROR_MESSAGE,
  faucetFailureRequiresManualCheck,
  safeFaucetDisplayMessage,
} from "@/lib/wallet/faucet-safety";
import Stepper from "./Stepper";
import WalletBackupDialog from "./port/WalletBackupDialog";

type Mode = "idle" | "create" | "import";
type FaucetState = "idle" | "requesting" | "success" | "error";

interface AccountPanelProps {
  account: ThruAccount | null;
  onAccountChange: (account: ThruAccount) => void;
  onContinue?: () => void;
  onForgetAccount: () => void | Promise<void>;
}

export default function AccountPanel({
  account,
  onAccountChange,
  onContinue,
  onForgetAccount,
}: AccountPanelProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [importReady, setImportReady] = useState(false);
  const importSecretRef = useRef<HTMLTextAreaElement>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [backedUp, setBackedUp] = useState(() => account !== null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [faucetState, setFaucetState] = useState<FaucetState>("idle");
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const faucetControllerRef = useRef<AbortController | null>(null);

  const clearImportSecret = useCallback(() => {
    clearSecretInputs(importSecretRef.current);
    setImportReady(false);
  }, []);

  const closeImport = () => {
    clearImportSecret();
    setMode("idle");
  };

  const refreshBalance = useCallback(async (address: string) => {
    setBalanceError(null);
    try {
      const bal = await getBalance(address);
      setBalance(bal);
    } catch (err) {
      if (isAccountNotFoundError(err)) {
        setBalance(0n);
        return;
      }
      setBalance(null);
      setBalanceError(
        "Balance is temporarily unavailable. Check your connection and try again.",
      );
    }
  }, []);

  useEffect(
    () => () => {
      faucetControllerRef.current?.abort();
      clearSecretInputs(importSecretRef.current);
    },
    [],
  );

  useEffect(() => {
    if (account) {
      setFaucetState("idle");
      setFaucetError(null);
      setLastSignature(null);
      setRetryInfo(null);
      setRevealKey(false);
      setBackupOpen(false);
      clearImportSecret();
      void refreshBalance(account.address);
    } else {
      setBalance(null);
      setBalanceError(null);
      setBackedUp(false);
      setBackupOpen(false);
      clearImportSecret();
    }
  }, [account, clearImportSecret, refreshBalance]);

  const currentStep = !account ? 1 : balance !== null && balance > 0n ? 3 : 2;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const acc = await createNewAccount(true);
      onAccountChange(acc);
      setBackedUp(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the account.");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    let importedPrivateKey: Uint8Array | null = null;
    let importValue = importSecretRef.current?.value ?? "";
    clearImportSecret();
    try {
      importedPrivateKey = hexToBytes(importValue);
      const acc = await accountFromPrivateKey(importedPrivateKey);
      onAccountChange(acc);
      setBackedUp(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't import that account. Check your private key.",
      );
    } finally {
      importValue = "";
      importedPrivateKey?.fill(0);
      clearImportSecret();
      setBusy(false);
    }
  }

  function copyAddress() {
    if (!account) return;
    void navigator.clipboard.writeText(account.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const [retryInfo, setRetryInfo] = useState<string | null>(null);

  async function handleFaucet() {
    if (
      !account ||
      faucetControllerRef.current ||
      faucetFailureRequiresManualCheck(faucetError)
    ) {
      return;
    }
    const controller = new AbortController();
    faucetControllerRef.current = controller;
    setFaucetState("requesting");
    setFaucetError(null);
    setRetryInfo(null);
    try {
      const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, {
        signal: controller.signal,
      });
      setRetryInfo(null);
      if (result.failureReason) {
        setFaucetState("error");
        setFaucetError(safeFaucetDisplayMessage(result.failureReason));
        setLastSignature(result.signature || null);
      } else {
        setFaucetState("success");
        setLastSignature(result.signature || null);
        await refreshBalance(account.address);
      }
    } catch {
      setRetryInfo(null);
      if (controller.signal.aborted) {
        setFaucetState("idle");
        setFaucetError(null);
        return;
      }
      setFaucetState("error");
      setFaucetError(SAFE_FAUCET_ERROR_MESSAGE);
    } finally {
      if (faucetControllerRef.current === controller) {
        faucetControllerRef.current = null;
      }
    }
  }

  function cancelFaucet() {
    faucetControllerRef.current?.abort();
  }

  function forgetAccount() {
    faucetControllerRef.current?.abort();
    onForgetAccount();
  }

  if (!account) {
    return (
      <>
        <Stepper current={currentStep} />
        <div className="panel">
          <h2 className="panel-title">Set up your account</h2>
          <p className="panel-sub">
            Create a new {THRU_NETWORK.displayName} account or restore an existing one. Signing
            happens locally; the network receives public account data and
            signed transactions, never your recovery phrase or private key.
          </p>

          {mode === "idle" && (
            <div className="stack">
              <button className="btn btn-primary" type="button" onClick={() => setMode("create")}>
                Create new account
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  clearImportSecret();
                  setMode("import");
                }}
              >
                Import existing account
              </button>
            </div>
          )}

          {mode === "create" && (
            <div className="stack">
              <p className="hint">
                We&apos;ll generate a 12-word recovery phrase. Write it down
                somewhere safe — if you lose it, there&apos;s no way to get
                your account back.
              </p>
              <button className="btn btn-primary" type="button" onClick={handleCreate} disabled={busy}>
                {busy ? "Creating…" : "Create account"}
              </button>
              <button className="btn btn-link" type="button" onClick={() => setMode("idle")}>
                ← Back
              </button>
            </div>
          )}

          {mode === "import" && (
            <div className="stack">
              <div className="tabs" role="tablist" aria-label="Import method">
                <button
                  className="tab tab-active"
                  type="button"
                  role="tab"
                  aria-selected="true"
                >
                  Private key (hex)
                </button>
              </div>
              <textarea
                ref={importSecretRef}
                className="input"
                aria-label="Private key in hexadecimal format"
                rows={2}
                placeholder="Hex private key, with or without 0x prefix"
                onChange={(event) =>
                  setImportReady(event.currentTarget.value.trim().length > 0)
                }
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <button
                className="btn btn-primary"
                type="button"
                onClick={handleImport}
                disabled={busy || !importReady}
              >
                {busy ? "Importing…" : "Import"}
              </button>
              <button className="btn btn-link" type="button" onClick={closeImport}>
                ← Back
              </button>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </div>
      </>
    );
  }

  return (
    <>
      <Stepper current={currentStep} />
      <div className="panel">
        <h2 className="panel-title">
          {currentStep === 3 ? "You're funded and ready to code" : "Fund your account"}
        </h2>
        {currentStep === 2 && (
          <p className="panel-sub">
            Pull free {THRU_NETWORK.displayName} test units from Thru&apos;s on-chain faucet —
            signed and submitted right here in your browser.
          </p>
        )}

        <div className="field">
          <span className="field-label">Address · safe to share</span>
          <div className="field-row">
            <code className="mono field-value">{account.address}</code>
            <div className="row" style={{ gap: 4 }}>
              <button
                className="icon-btn"
                type="button"
                onClick={copyAddress}
                title="Copy address"
                aria-label="Copy account address"
              >
                {copied ? "✓" : "⧉"}
              </button>
              <a
                className="icon-btn"
                href={explorerAddressUrl(account.address)}
                target="_blank"
                rel="noreferrer"
                title="View on explorer"
              >
                ↗
              </a>
            </div>
          </div>
        </div>

        <div className="field">
          <span className="field-label">Balance</span>
          <div className="field-row">
            <span className="field-value">
              {balance === null ? "…" : balance.toString()}{" "}
              <span className="unit">tTHRU</span>
            </span>
            <button
              className="icon-btn"
              type="button"
              onClick={() => refreshBalance(account.address)}
              title="Refresh"
              aria-label="Refresh account balance"
            >
              ↻
            </button>
          </div>
          {balanceError && <p className="error field-error">{balanceError}</p>}
        </div>

        {!backedUp && (
          <div className="warning-box">
            <p>
              <strong>One last reminder.</strong> Make sure you&apos;ve backed
              up your wallet. The downloaded JSON encrypts the wallet secrets
              with a password that only you know.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => setBackupOpen(true)}
              >
                Download encrypted backup
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setRevealKey((v) => !v)}
              >
                {revealKey
                  ? "Hide secret"
                  : account.mnemonic
                    ? "Reveal recovery phrase"
                    : "Reveal private key"}
              </button>
            </div>
            {revealKey && (
              <code className="mono reveal">
                {account.mnemonic ??
                  Array.from(account.privateKey, (b) => b.toString(16).padStart(2, "0")).join("")}
              </code>
            )}
          </div>
        )}

        {backedUp && faucetState !== "success" && balance === 0n && (
          <div className="stack">
            <button
              className="btn btn-primary"
              type="button"
              onClick={handleFaucet}
              disabled={
                faucetState === "requesting" ||
                faucetFailureRequiresManualCheck(faucetError)
              }
            >
              {faucetState === "requesting"
                ? "Requesting tokens…"
                : `Get ${FAUCET_WITHDRAW_LIMIT} test units`}
            </button>
            {faucetState === "requesting" && retryInfo && (
              <p className="hint">{retryInfo}</p>
            )}
            {faucetState === "requesting" && (
              <button className="btn btn-link" type="button" onClick={cancelFaucet}>
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
              </div>
            )}
          </div>
        )}

        {faucetState === "success" && (
          <div className="success-box">
            <span>✓</span> Funded! {lastSignature && (
              <a
                className="mono"
                style={{ color: "inherit" }}
                href={explorerTransactionUrl(lastSignature)}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
            )}
          </div>
        )}

        {(currentStep === 3 || faucetState === "success") && onContinue && (
          <button
            className="btn btn-primary"
            type="button"
            onClick={onContinue}
            style={{ width: "100%" }}
          >
            Continue to editor →
          </button>
        )}
        <button
          className="btn btn-link danger-link"
          type="button"
          onClick={forgetAccount}
        >
          Forget this account
        </button>
      </div>
      {backupOpen && (
        <WalletBackupDialog
          account={account}
          onClose={() => setBackupOpen(false)}
          onExported={() => setBackedUp(true)}
        />
      )}
    </>
  );
}
