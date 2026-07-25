import { useState, useRef, useEffect, useCallback } from "react";
import {
  transferTokensOnAlphaNet,
  createDestinationTokenAccountOnAlphaNet,
  previewDestinationTokenAccount,
  type TransferTokenResult
} from "@/lib/token/thru-token";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

export function useTokenTransfer({
  account,
  onSuccess,
}: {
  account: ThruAccount | null;
  onSuccess?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransferTokenResult | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const resetState = useCallback(() => {
    setError(null);
    setResult(null);
    setProgressLabel(null);
  }, []);

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
    if (!account) return;

    const controller = new AbortController();
    controllerRef.current?.abort();
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
          onProgress: () => {},
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
          onProgress: () => {},
        }
      );

      setResult(next);
      if (onSuccess) onSuccess();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Transfer failed.";
      setError(
        controller.signal.aborted
          ? "Cancelled."
          : message
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
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
