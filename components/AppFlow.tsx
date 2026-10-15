"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import {
  type ThruAccount,
  createNewAccount,
  accountFromPrivateKey,
  hexToBytes,
} from "@/lib/wallet/thru-wallet";
import {
  restorePersistedWallet,
  removePersistedWallet,
  saveAndVerifyPersistedWallet,
  completePersistedWalletSetup,
  isPersistedWalletSetupPending,
  WALLET_REMOVAL_ERROR,
  WALLET_SAVE_ERROR,
  WalletVaultError,
} from "@/lib/wallet/persistent-wallet";
import {
  WalletBackupError,
  decryptEncryptedWalletBackupContents,
  readEncryptedBackupFile,
} from "@/lib/wallet/wallet-backup";
import {
  restoreCreatedTokenCatalog,
  type KnownTokenRecord,
} from "@/lib/token/portfolio";
import { withdrawFromFaucet, FAUCET_WITHDRAW_LIMIT } from "@/lib/wallet/faucet";
import {
  SAFE_FAUCET_ERROR_MESSAGE,
  faucetFailureRequiresManualCheck,
  safeFaucetDisplayMessage,
} from "@/lib/wallet/faucet-safety";
import TokenStudio from "./TokenStudio";
import NameStudio from "./NameStudio";
import type { WorkspaceStage } from "./port/PortHeader";
import OneTimePrivateKeyBackup from "./port/OneTimePrivateKeyBackup";
import { useNetworkHealth } from "./port/useNetworkHealth";
import { shouldShowOneTimePrivateKeyBackup } from "@/lib/wallet/one-time-private-key-backup";
import CommandShell from "./command/CommandShell";
import CommandDashboard from "./command/CommandDashboard";
import { useTokenPortfolio } from "@/lib/token/portfolio-hook";
import NativeTransferProvider from "./command/NativeTransferProvider";
import { NativeBalanceReader, visibleNativeObservation } from "@/lib/portfolio/native-observation";
import { buildWalletPortfolio, type NativeObservation, type PortfolioScope } from "@/lib/portfolio/asset-model";
import { THRU_NETWORK } from "@/lib/thru/network";

export default function AppFlow() {
  const [stage, setStage] = useState<WorkspaceStage>("account");
  const [account, setAccount] = useState<ThruAccount | null>(null);
  const [
    showOneTimePrivateKeyBackup,
    setShowOneTimePrivateKeyBackup,
  ] = useState(false);

  // Wallet logic moved up
  const [nativeObservation, setNativeObservation] = useState<NativeObservation | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [restoreStatus, setRestoreStatus] = useState<
    "RESTORING" | "WALLET_READY" | "NO_SAVED_WALLET" | "VAULT_ERROR"
  >("RESTORING");
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);

  const [faucetState, setFaucetState] = useState<"idle" | "requesting" | "success" | "error">("idle");
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const faucetControllerRef = useRef<AbortController | null>(null);
  const balanceReaderRef = useRef<NativeBalanceReader | null>(null);
  if (!balanceReaderRef.current) balanceReaderRef.current = new NativeBalanceReader();
  const balanceMountedRef = useRef(false);
  const walletOperationRef = useRef(false);
  const removalPromiseRef = useRef<Promise<void> | null>(null);

  const health = useNetworkHealth();
  const balanceScope: PortfolioScope | null = account ? { networkId: THRU_NETWORK.id,
    chainId: THRU_NETWORK.expectedChainId, walletAddress: account.address } : null;
  const balanceScopeKey = `${THRU_NETWORK.storageScope}:${account?.address ?? ""}:${health.status}`;
  const balanceScopeRef = useRef(balanceScopeKey);
  balanceScopeRef.current = balanceScopeKey;
  const visibleBalance = visibleNativeObservation(balanceScope, nativeObservation, health.status);
  const balance = visibleBalance?.rawBalance ?? null;
  const balanceError = !account || balance !== null ? null : health.status === "Offline"
    ? "Balance unavailable while RPC is offline." : health.status === "Checking"
      ? "Balance check is pending RPC availability." : visibleBalance?.availability === "unavailable"
        ? health.status === "Degraded" ? "Balance temporarily unavailable while RPC is unstable."
          : "Balance temporarily unavailable." : null;

  // Lifted portfolio hook
  const portfolioHook = useTokenPortfolio(account, {
    networkStatus: health?.status,
  });
  const [, expireObservation] = useState(0);
  const portfolioModel = balanceScope ? buildWalletPortfolio({ scope: balanceScope,
    native: nativeObservation, tokens: portfolioHook.modelSnapshot ?? null,
    networkStatus: health.status, now: Date.now() }) : null;
  // Display expiry only: no discovery, RPC read, or timestamp refresh.
  useEffect(() => {
    if (!portfolioModel) return;
    const now = Date.now();
    const expiries = [portfolioModel.native.observation, ...portfolioModel.tokens.flatMap((asset) =>
      [asset.observation, ...asset.sources.map((source) => source.observation)])]
      .flatMap((observation) => observation.source === "rpc" && observation.observedAt !== null && observation.observedAt <= now
        ? [observation.observedAt + 60_001] : []).filter((expiry) => expiry > now);
    if (!expiries.length) return;
    const timer = setTimeout(() => expireObservation((revision) => revision + 1), Math.min(...expiries) - now);
    return () => clearTimeout(timer);
  }, [portfolioModel]);

  const refreshBalance = useCallback(async (address: string) => {
    if (!balanceMountedRef.current || address !== account?.address || balanceScopeRef.current !== balanceScopeKey) return;
    const observation = await balanceReaderRef.current?.read({ networkId: THRU_NETWORK.id,
      chainId: THRU_NETWORK.expectedChainId, walletAddress: address }, health.status,
      () => balanceMountedRef.current && balanceScopeRef.current === balanceScopeKey);
    if (observation && balanceMountedRef.current && balanceScopeRef.current === balanceScopeKey) setNativeObservation(observation);
  }, [account?.address, balanceScopeKey, health.status]);

  useEffect(() => {
    balanceMountedRef.current = true;
    return () => {
      balanceMountedRef.current = false;
      faucetControllerRef.current?.abort();
      balanceReaderRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    let active = true;
    restorePersistedWallet()
      .then(async (restored) => {
        const setupPending = restored
          ? await isPersistedWalletSetupPending(restored.address)
          : false;
        if (!active) {
          restored?.privateKey.fill(0);
          if (restored) restored.mnemonic = undefined;
          return;
        }
        if (restored) {
          restored.mnemonic = undefined;
          setShowOneTimePrivateKeyBackup(setupPending);
          setAccount(restored);
          setRestoreStatus("WALLET_READY");
        } else {
          setShowOneTimePrivateKeyBackup(false);
          setRestoreStatus("NO_SAVED_WALLET");
        }
      })
      .catch(() => {
        if (!active) return;
        setShowOneTimePrivateKeyBackup(false);
        setAccount(null);
        setRestoreStatus("VAULT_ERROR");
        setWalletError(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (account) {
      setFaucetState("idle");
      setFaucetError(null);
      setLastSignature(null);
      setRetryInfo(null);
      if (health.status === "Online" || health.status === "Degraded") {
        void refreshBalance(account.address);
      } else {
        balanceReaderRef.current?.cancel();
        setNativeObservation(null);
      }
    } else {
      balanceReaderRef.current?.cancel();
      setNativeObservation(null);
    }
    return () => balanceReaderRef.current?.cancel();
  }, [account, refreshBalance, health.status]);

  async function handleCreateWallet(): Promise<boolean> {
    if (
      walletOperationRef.current ||
      restoreStatus !== "NO_SAVED_WALLET" ||
      account
    ) {
      return false;
    }
    walletOperationRef.current = true;
    setWalletBusy(true);
    setWalletError(null);
    setPersistenceWarning(null);
    let candidate: ThruAccount | null = null;
    try {
      candidate = await createNewAccount(false);
      const persisted = await saveAndVerifyPersistedWallet(candidate, {
        setupPending: true,
      });
      persisted.mnemonic = undefined;
      setShowOneTimePrivateKeyBackup(
        shouldShowOneTimePrivateKeyBackup("created"),
      );
      setAccount(persisted);
      setRestoreStatus("WALLET_READY");
      return true;
    } catch (err) {
      if (err instanceof WalletVaultError) {
        setRestoreStatus("VAULT_ERROR");
        setWalletError(WALLET_SAVE_ERROR);
      } else {
        setWalletError("Couldn't create the account securely.");
      }
      return false;
    } finally {
      candidate?.privateKey.fill(0);
      if (candidate) candidate.mnemonic = undefined;
      walletOperationRef.current = false;
      setWalletBusy(false);
    }
  }

  async function handleImportWallet(
    kind: "hex",
    value: string,
  ): Promise<boolean> {
    if (
      walletOperationRef.current ||
      restoreStatus !== "NO_SAVED_WALLET" ||
      account
    ) {
      value = "";
      return false;
    }
    walletOperationRef.current = true;
    setWalletBusy(true);
    setWalletError(null);
    setPersistenceWarning(null);
    let importedPrivateKey: Uint8Array | null = null;
    let candidate: ThruAccount | null = null;
    try {
      importedPrivateKey = hexToBytes(value);
      candidate = await accountFromPrivateKey(importedPrivateKey);
      const persisted = await saveAndVerifyPersistedWallet(candidate);
      persisted.mnemonic = undefined;
      setShowOneTimePrivateKeyBackup(
        shouldShowOneTimePrivateKeyBackup("private-key-import"),
      );
      setAccount(persisted);
      setRestoreStatus("WALLET_READY");
      return true;
    } catch (err) {
      if (err instanceof WalletVaultError) {
        setRestoreStatus("VAULT_ERROR");
        setWalletError(WALLET_SAVE_ERROR);
      } else {
        setWalletError(
          "Couldn't import that account. Check your private key.",
        );
      }
      return false;
    } finally {
      value = "";
      importedPrivateKey?.fill(0);
      candidate?.privateKey.fill(0);
      if (candidate) candidate.mnemonic = undefined;
      walletOperationRef.current = false;
      setWalletBusy(false);
    }
  }

  async function handleImportBackup(
    file: File,
    password: string,
  ): Promise<boolean> {
    if (
      walletOperationRef.current ||
      restoreStatus !== "NO_SAVED_WALLET" ||
      account
    ) {
      password = "";
      return false;
    }
    walletOperationRef.current = true;
    setWalletBusy(true);
    setWalletError(null);
    setPersistenceWarning(null);
    let serialized = "";
    let candidate: ThruAccount | null = null;
    let restoredCreatedTokens: KnownTokenRecord[] = [];
    try {
      serialized = await readEncryptedBackupFile(file);
      const restored = await decryptEncryptedWalletBackupContents(
        serialized,
        password,
      );
      candidate = restored.account;
      restoredCreatedTokens = restored.createdTokens;
      const persisted = await saveAndVerifyPersistedWallet(candidate);
      persisted.mnemonic = undefined;
      try {
        restoreCreatedTokenCatalog(
          window.localStorage,
          persisted.address,
          restoredCreatedTokens,
        );
      } catch {
        // Public catalog restoration must not invalidate a verified wallet.
      }
      setShowOneTimePrivateKeyBackup(
        shouldShowOneTimePrivateKeyBackup("encrypted-backup-import"),
      );
      setAccount(persisted);
      setRestoreStatus("WALLET_READY");
      return true;
    } catch (err) {
      if (err instanceof WalletBackupError) {
        setWalletError(err.message);
      } else if (err instanceof WalletVaultError) {
        setRestoreStatus("VAULT_ERROR");
        setWalletError(WALLET_SAVE_ERROR);
      } else {
        setWalletError("Unable to import this encrypted wallet backup.");
      }
      return false;
    } finally {
      password = "";
      serialized = "";
      restoredCreatedTokens = [];
      candidate?.privateKey.fill(0);
      if (candidate) candidate.mnemonic = undefined;
      walletOperationRef.current = false;
      setWalletBusy(false);
    }
  }

  async function handleFaucet() {
    if (
      !account ||
      health.status !== "Online" ||
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

  async function handleCompleteWalletSetup(): Promise<boolean> {
    if (!account || !showOneTimePrivateKeyBackup) return false;
    try {
      await completePersistedWalletSetup(account.address);
      setShowOneTimePrivateKeyBackup(false);
      return true;
    } catch {
      return false;
    }
  }

  // Phase 2 disconnect
  function forgetAccount(): Promise<void> {
    if (removalPromiseRef.current) return removalPromiseRef.current;
    const activeAccount = account;
    const removal = (async () => {
      try {
        await removePersistedWallet();
      } catch {
        throw new Error(WALLET_REMOVAL_ERROR);
      }
      faucetControllerRef.current?.abort();
      activeAccount?.privateKey.fill(0);
      if (activeAccount) activeAccount.mnemonic = undefined;
      setShowOneTimePrivateKeyBackup(false);
      setAccount(null);
      setRestoreStatus("NO_SAVED_WALLET");
      setWalletError(null);
      setPersistenceWarning(null);
      setStage("account");
    })().finally(() => {
      removalPromiseRef.current = null;
    });
    removalPromiseRef.current = removal;
    return removal;
  }

  if (account && showOneTimePrivateKeyBackup) {
    return (
      <OneTimePrivateKeyBackup
        account={account}
        onContinue={handleCompleteWalletSetup}
      />
    );
  }

  return (
    <NativeTransferProvider account={account} balance={balance} networkStatus={health.status}
      onSuccess={(wallet) => { void refreshBalance(wallet); }}>
    <CommandShell
      currentStage={stage}
      accountAvailable={Boolean(account)}
      publicAddress={account?.address}
      account={account}
      balance={balance}
      onStageChange={setStage}
      health={health}
      onForgetAccount={forgetAccount}
    >
      {stage === "account" && (
        <CommandDashboard
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
          onImportBackup={handleImportBackup}
          onRequestFaucet={handleFaucet}
          onCancelFaucet={cancelFaucet}
          onForgetAccount={forgetAccount}
          restoreStatus={restoreStatus}
          persistenceWarning={persistenceWarning}
          portfolioHook={portfolioHook}
          portfolioModel={portfolioModel}
        />
      )}
      {stage === "token" && account && (
        <div style={{ marginTop: 24, flex: 1, overflow: "auto" }}>
          <TokenStudio account={account} health={health} portfolioHook={portfolioHook} portfolioModel={portfolioModel} />
        </div>
      )}
      {stage === "name" && account && (
        <div style={{ padding: "4rem", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
           <NameStudio account={account} health={health} walletReady={true} />
        </div>
      )}
    </CommandShell>
    </NativeTransferProvider>
  );
}

