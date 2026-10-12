"use client";

import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { thru } from "@/lib/thru/client";
import type { NetworkStatus } from "@/lib/network/network-health";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { transferNativeUnits, reconcileNativeTransfer } from "@/lib/wallet/native-transfer";
import { loadNativeTransfers, nativeJournalStorage, PENDING_NATIVE_TRANSFER_KEY } from "@/lib/wallet/pending-native-transfer";
import { NATIVE_SEND_ENABLED, NativeTransferController } from "@/lib/wallet/native-transfer-controller";
import { NativeTransferError } from "@/lib/wallet/native-transfer-validation";
import NativeTransferConfirmation from "./NativeTransferConfirmation";

const Context = createContext<NativeTransferController | null>(null);
export function useNativeTransfer() {
  const controller = useContext(Context);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  return { controller, state };
}
const noopSubscribe = () => () => {};
const emptySnapshot = () => null;

/** Only this existing wallet-owner boundary closes over the active signing wallet. */
export default function NativeTransferProvider({ account, balance, networkStatus, onSuccess, children }: {
  account: ThruAccount | null; balance: bigint | null; networkStatus: NetworkStatus;
  onSuccess: (wallet: string) => void; children: React.ReactNode;
}) {
  const current = useRef({ account, onSuccess });
  current.current = { account, onSuccess };
  const controllers = useRef(new Map<string, NativeTransferController>());
  const wallet = account?.address;
  let controller = wallet ? controllers.current.get(wallet) : null;
  if (wallet && !controller) {
    controller = new NativeTransferController(wallet, {
      enabled: NATIVE_SEND_ENABLED,
      readAccount: (address) => thru.accounts.get(address), chainId: () => thru.chain.getChainId(),
      pending: () => loadNativeTransfers(nativeJournalStorage()).find((record) => record.walletAddress === wallet),
      execute: (recipient, amount, signal) => {
        const active = current.current.account;
        if (!NATIVE_SEND_ENABLED || !active || active.address !== wallet) throw new NativeTransferError("INVALID_IDENTITY");
        return transferNativeUnits(active, recipient, amount, { signal });
      },
      reconcile: (signal) => reconcileNativeTransfer(wallet, { signal }),
      onSuccess: () => { if (current.current.account?.address === wallet) current.current.onSuccess(wallet); },
    });
    controllers.current.set(wallet, controller);
  }
  useEffect(() => {
    controller?.setEnvironment(balance, networkStatus);
  }, [controller, balance, networkStatus]);
  useEffect(() => {
    controller?.hydrate();
    const recover = (event: StorageEvent) => {
      if (event.key === PENDING_NATIVE_TRANSFER_KEY || event.key === null) controller?.hydrate();
    };
    window.addEventListener("storage", recover);
    return () => { window.removeEventListener("storage", recover); controller?.deactivate(); };
  }, [controller]);
  return <Context.Provider value={controller ?? null}>{children}<NativeTransferConfirmation /></Context.Provider>;
}
