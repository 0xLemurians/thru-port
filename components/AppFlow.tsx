"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type ThruAccount,
  createNewAccount,
  accountFromMnemonic,
  accountFromPrivateKey,
  getBalance,
  hexToBytes,
  isAccountNotFoundError,
} from "@/lib/wallet/thru-wallet";
import EditorPanel from "./EditorPanel";
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

  useEffect(() => {
    if (account) {
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

  // Not implemented yet (Phase 2), but we provide a dummy disconnect to clear memory
  function forgetAccount() {
    account?.privateKey.fill(0);
    setAccount(null);
    setStage("account");
  }

  return (
    <PortShell
      currentStage={stage}
      accountAvailable={Boolean(account)}
      publicAddress={account?.address}
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
          onCreateWallet={handleCreateWallet}
          onImportWallet={handleImportWallet}
        />
      )}
      {stage === "token" && account && (
        <div style={{ marginTop: 24 }}>
          <TokenStudio account={account} />
        </div>
      )}
      {stage === "name" && account && (
        <div style={{ marginTop: 24 }}>
          <NameStudio />
        </div>
      )}
      {stage === "editor" && account && (
        <div style={{ marginTop: 24 }}>
          <EditorPanel
            accountAddress={account.address}
            onBack={() => setStage("account")}
            onForgetAccount={forgetAccount}
          />
        </div>
      )}
    </PortShell>
  );
}
