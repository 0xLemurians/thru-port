import { useState, useRef, useEffect, useCallback } from "react";
import {
  transferTokensOnAlphaNet,
  createDestinationTokenAccountOnAlphaNet,
  previewDestinationTokenAccount,
  type TransferTokenResult
} from "@/lib/token/thru-token";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  TransactionStatusUncertainError,
} from "./transaction-status";

interface CachedTransferUiState {
  progressLabel: string | null;
  error: string | null;
  result: TransferTokenResult | null;
}

const transferUiState = new Map<string, CachedTransferUiState>();

export function useTokenTransfer({
  account,
  onSuccess,
}: {
  account: ThruAccount | null;
  onSuccess?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const cached = account ? transferUiState.get(account.address) : undefined;
  const [progressLabel, setProgressLabel] = useState<string | null>(
    cached?.progressLabel ?? null,
  );
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [result, setResult] = useState<TransferTokenResult | null>(
    cached?.result ?? null,
  );

  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

  const remember = useCallback((next: CachedTransferUiState) => {
    if (account) transferUiState.set(account.address, next);
  }, [account]);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const resetState = useCallback(() => {
    setError(null);
    setResult(null);
    setProgressLabel(null);
    if (account) transferUiState.delete(account.address);
  }, [account]);

  async function transfer({
    selectedTokenMint,
    transferSource,
    transferDestination,
    transferAmount,
  }: {
    selectedTokenMint: string;
    transferSource: string;
    transferDestination: string;
    transferAmount: string;
  }) {
    if (!account || inFlightRef.current) return;

    const controller = new AbortController();
    inFlightRef.current = true;
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgressLabel("Resolving recipient...");

    try {
      // Step 1: Prepare the destination token account
      setProgressLabel("Preparing recipient account...");
      const preview = previewDestinationTokenAccount({
        mintAddress: selectedTokenMint,
        destinationOwnerAddress: transferDestination
      });

      const createResult = await createDestinationTokenAccountOnAlphaNet(
        account,
        {
          mintAddress: preview.mintAddress,
          destinationOwnerAddress: preview.destinationOwnerAddress,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "waiting-final-consensus") {
              setProgressLabel("Confirming recipient account...");
            } else if (progress.stage === "refetching-on-chain-state") {
              setProgressLabel("Verifying recipient account...");
            }
          },
        }
      );

      const finalDestination = createResult.tokenAccountAddress;

      // Step 2: Transfer tokens
      setProgressLabel("Sending token...");

      const next = await transferTokensOnAlphaNet(
        account,
        {
          sourceAddress: transferSource,
          destinationAddress: finalDestination,
          amount: transferAmount,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "waiting-final-consensus") {
              setProgressLabel("Confirming token transfer...");
            } else if (progress.stage === "refetching-on-chain-state") {
              setProgressLabel("Verifying token balances...");
            }
          },
        }
      );

      setResult(next);
      remember({ progressLabel: null, error: null, result: next });
      if (onSuccess) onSuccess();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Transfer failed.";
      const safeMessage =
        cause instanceof TransactionStatusUncertainError
          ? SAFE_TRANSACTION_UNCERTAIN_MESSAGE
          : controller.signal.aborted
            ? "Cancelled before submission."
            : message;
      setError(safeMessage);
      remember({ progressLabel: null, error: safeMessage, result: null });
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      inFlightRef.current = false;
      setBusy(false);
      setProgressLabel(null);
    }
  }

  return {
    busy,
    progressLabel,
    error,
    result,
    transfer,
    resetState
  };
}
