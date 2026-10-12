"use client";

import React, { useId } from "react";
import { useNativeTransfer } from "./NativeTransferProvider";
import { nativeSendAvailable, nativeSendBusy, type NativeSendSnapshot, type NativeTransferController } from "@/lib/wallet/native-transfer-controller";
import { parseNativeTransferAmount, nativeTransferAddress, NativeTransferError, NATIVE_TRANSFER_HEADER } from "@/lib/wallet/native-transfer-validation";
import { explorerTransactionUrl } from "@/lib/thru/network";
import styles from "./command.module.css";

export default function NativeSendForm() {
  const { controller, state } = useNativeTransfer();
  if (!controller || !state) return <p>Connect a saved wallet to send native units.</p>;
  return <NativeSendFields state={state} controller={controller} />;
}

/** The same public-state view is used in Quick Send and the wallet popover. */
export function NativeSendFields({ state, controller }: { state: NativeSendSnapshot; controller: NativeTransferController }) {
  const id = useId();
  const busy = nativeSendBusy(state);
  const available = nativeSendAvailable(state);
  let draftValid = false;
  let draftError: string | null = null;
  try {
    if (!state.recipient || !state.amount) throw new Error();
    nativeTransferAddress(state.recipient);
    const amount = parseNativeTransferAmount(state.amount);
    if (state.recipient === state.wallet) throw new NativeTransferError("SELF_TRANSFER");
    if (state.balance !== null && amount + NATIVE_TRANSFER_HEADER.fee > state.balance) throw new NativeTransferError("INSUFFICIENT_BALANCE");
    draftValid = state.balance !== null;
  } catch (error) { if (error instanceof NativeTransferError) draftError = error.message; }
  return <form className={styles.quickSend} aria-label="Native transfer" aria-busy={busy}
    onSubmit={(event) => { event.preventDefault(); if (available && draftValid) void controller.prepare(); }}>
    <p className={styles.nativeHint}>Available: {state.balance === null ? "Unavailable" : `${state.balance} native units`}</p>
    <p className={styles.nativeHint}>Enter integer raw native units. No THRU denomination conversion is applied.</p>
    {!state.enabled && <p className={styles.nativeHint}>Native sending is not enabled yet. It requires an approved disposable-wallet smoke test.</p>}
    {state.networkStatus === "Degraded" && <p className={styles.nativeHint}>Betanet reads may be unstable. Fresh checks remain required.</p>}
    {["Offline", "Checking"].includes(state.networkStatus) && <p className={styles.nativeHint}>Native sending is unavailable until Betanet reads can be verified.</p>}
    <div className={styles.inputGroup}>
      <label className={styles.inputLabel} htmlFor={`${id}-recipient`}>Recipient Thru address</label>
      <input id={`${id}-recipient`} className={styles.inputText} value={state.recipient} spellCheck={false} autoComplete="off"
        disabled={busy || state.blocked} onChange={(event) => controller.setDraft("recipient", event.target.value)} />
    </div>
    <div className={styles.inputGroup}>
      <label className={styles.inputLabel} htmlFor={`${id}-amount`}>Amount (integer native units)</label>
      <div className={styles.inputAmountWrapper}>
        <input id={`${id}-amount`} className={styles.inputText} inputMode="numeric" value={state.amount} placeholder="0"
          disabled={busy || state.blocked} onChange={(event) => controller.setDraft("amount", event.target.value)} />
        <button type="button" className={styles.maxBtn} disabled={!available || !state.recipient} onClick={() => void controller.prepare(true)}>MAX</button>
      </div>
    </div>
    <p className={styles.nativeHint}>Fee: 1 raw native unit. Only existing Betanet EOA recipients are supported.</p>
    {draftError && !state.error && <p className={styles.nativeValidation} role="alert">{draftError}</p>}
    <button type="submit" className={styles.btnPrimaryFull} disabled={!available || !draftValid}>Review Send</button>
    <NativeTransferStatus state={state} onReconcile={() => void controller.reconcile()} />
  </form>;
}

export function NativeTransferStatus({ state, onReconcile }: { state: NativeSendSnapshot; onReconcile: () => void }) {
  const labels = { idle: "", preparing: "Preparing", "awaiting-confirmation": "Awaiting confirmation", submitting: "Submitting — awaiting verified result", confirming: "Confirming", success: "Success — native transfer verified", failed: "Failed", uncertain: "Uncertain — check status before trying again" };
  return <div className={styles.nativeStatus} role="status" aria-live="polite">
    {labels[state.phase] && <p>{labels[state.phase]}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.phase === "uncertain" && <p>The transaction may have been submitted. Final confirmation is unavailable. Check the Explorer before trying again.</p>}
    {state.result?.signature && <>
      <p className={styles.nativeAddress}>{state.result.signature}</p>
      <a href={explorerTransactionUrl(state.result.signature)} target="_blank" rel="noopener noreferrer">View Betanet Explorer ↗</a>
    </>}
    {state.result?.persistenceWarning && <p>The verified result could not be saved completely. Pending storage remains locked; verify before another write.</p>}
    {state.blocked && <button type="button" className={styles.btnSecondaryFull} disabled={nativeSendBusy(state) || !["Online", "Degraded"].includes(state.networkStatus)} onClick={onReconcile}>Refresh status (read-only)</button>}
  </div>;
}
