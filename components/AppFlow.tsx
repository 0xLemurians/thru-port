"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import {
  type ThruAccount,
  createNewAccount,
  accountFromMnemonic,
  accountFromPrivateKey,
  getBalance,
  hexToBytes,
  isAccountNotFoundError,
} from "@/lib/wallet/thru-wallet";
import { withdrawFromFaucet, FAUCET_WITHDRAW_LIMIT } from "@/lib/wallet/faucet";
import NameStudio from "./NameStudio";
import TokenStudio from "./TokenStudio";
import type { WorkspaceStage } from "./port/PortHeader";
import PortShell from "./port/PortShell";
import PortDashboard from "./port/PortDashboard";
import { useAlphaNetHealth } from "./port/useAlphaNetHealth";

export default function AppFlow() {
  const [stage, setStage] = useState<WorkspaceStage>("account");
  const [account, setAccount] = useState<ThruAccount | null>(null);

  // Wallet logic moved up
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [faucetState, setFaucetState] = useState<"idle" | "requesting" | "success" | "error">("idle");
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const faucetControllerRef = useRef<AbortController | null>(null);

  const health = useAlphaNetHealth();

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
      if (health.status === "Offline") {
        setBalanceError("Balance unavailable while RPC is offline.");
      } else if (health.status === "Degraded") {
        setBalanceError("Balance temporarily unavailable while RPC is unstable.");
      } else if (health.status === "Checking") {
        setBalanceError("Balance check is pending RPC availability.");
      } else {
        setBalanceError("Balance temporarily unavailable.");
      }
    }
  }, [health.status]);

  useEffect(
    () => () => {
      faucetControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (account) {
      setFaucetState("idle");
      setFaucetError(null);
      setLastSignature(null);
      setRetryInfo(null);
      void refreshBalance(account.address);
    } else {
      setBalance(null);
      setBalanceError(null);
    }
  }, [account, refreshBalance, health.status]);

  async function handleCreateWallet() {
    setWalletBusy(true);
    setWalletError(null);
    try {
      const acc = await createNewAccount(true);
      setAccount(acc);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Couldn't create the account.");
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleImportWallet(kind: "mnemonic" | "hex", value: string) {
    setWalletBusy(true);
    setWalletError(null);
    let importedPrivateKey: Uint8Array | null = null;
    try {
      let acc: ThruAccount;
      if (kind === "mnemonic") {
        const normalizedMnemonic = value.trim().replace(/\s+/g, " ");
        acc = await accountFromMnemonic(normalizedMnemonic);
      } else {
        importedPrivateKey = hexToBytes(value);
        acc = await accountFromPrivateKey(importedPrivateKey);
      }
      setAccount(acc);
    } catch (err) {
      setWalletError(
        err instanceof Error
          ? err.message
          : "Couldn't import that account. Check your recovery phrase or private key.",
      );
    } finally {
      importedPrivateKey?.fill(0);
      setWalletBusy(false);
    }
  }

  async function handleFaucet() {
    if (!account) return;
    const controller = new AbortController();
    faucetControllerRef.current?.abort();
    faucetControllerRef.current = controller;
    setFaucetState("requesting");
    setFaucetError(null);
    setRetryInfo(null);
    try {
      const result = await withdrawFromFaucet(account, FAUCET_WITHDRAW_LIMIT, {
        signal: controller.signal,
        onRetry: ({ attempt, maxAttempts, delayMs }) => {
          setRetryInfo(
            attempt === 0
              ? "Creating and confirming your account on-chain…"
              : `AlphaNet seems busy — retrying (${attempt}/${maxAttempts}) in ${Math.round(delayMs / 1000)}s…`,
          );
        },
      });
      setRetryInfo(null);
      if (result.failureReason) {
        setFaucetState("error");
        setFaucetError(result.failureReason);
      } else {
        setFaucetState("success");
        setLastSignature(result.signature || null);
        await refreshBalance(account.address);
      }
    } catch (err) {
      setRetryInfo(null);
      if (controller.signal.aborted) {
        setFaucetState("idle");
        setFaucetError(null);
        return;
      }
      setFaucetState("error");
      setFaucetError(
          err instanceof Error ? err.message : "Faucet request failed. AlphaNet may be busy — try again in a moment.",
      );
    } finally {
      if (faucetControllerRef.current === controller) {
        faucetControllerRef.current = null;
      }
    }
  }

  function cancelFaucet() {
    faucetControllerRef.current?.abort();
  }

  // Phase 2 disconnect
  function forgetAccount() {
    faucetControllerRef.current?.abort();
    account?.privateKey.fill(0);
    setAccount(null);
    setStage("account");
  }

  return (
    <PortShell
      currentStage={stage}
      accountAvailable={Boolean(account)}
      publicAddress={account?.address}
      account={account}
      balance={balance}
      onStageChange={setStage}
      health={health}
    >
      {stage === "account" && (
        <PortDashboard
          account={account}
          balance={balance}
          balanceError={balanceError}
          walletBusy={walletBusy}
          walletError={walletError}
          health={health}
          faucetState={faucetState}
          faucetError={faucetError}
          retryInfo={retryInfo}
          lastSignature={lastSignature}
          onCreateWallet={handleCreateWallet}
          onImportWallet={handleImportWallet}
          onRequestFaucet={handleFaucet}
          onCancelFaucet={cancelFaucet}
          onForgetAccount={forgetAccount}
        />
      )}
      {stage === "token" && account && (
        <div style={{ marginTop: 24 }}>
          <TokenStudio account={account} health={health} />
        </div>
      )}
      {stage === "name" && account && (
        <div style={{ marginTop: 24 }}>
          <NameStudio />
        </div>
      )}
    </PortShell>
  );
}
