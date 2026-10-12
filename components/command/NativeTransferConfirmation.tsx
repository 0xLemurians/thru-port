"use client";

import React, { useEffect, useId, useRef } from "react";
import { useNativeTransfer } from "./NativeTransferProvider";
import type { NativeReview } from "@/lib/wallet/native-transfer-controller";
import styles from "./command.module.css";

export default function NativeTransferConfirmation() {
  const { controller, state } = useNativeTransfer();
  return state?.review && controller ? <NativeConfirmationDialog review={state.review} onCancel={controller.cancelReview} onConfirm={() => void controller.confirm()} /> : null;
}

export function NativeConfirmationDialog({ review, onCancel, onConfirm }: {
  review: NativeReview; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className={styles.nativeDialog} aria-labelledby={title}
    onCancel={(event) => { event.preventDefault(); onCancel(); }} onClose={onCancel}>
    <h3 id={title}>Confirm native transfer</h3>
    <dl className={styles.nativeReview}>
      <dt>NETWORK</dt><dd>Thru Betanet</dd>
      <dt>FROM</dt><dd>{review.wallet}</dd>
      <dt>TO</dt><dd>{review.recipient}</dd>
      <dt>ASSET</dt><dd>Native units</dd>
      <dt>AMOUNT</dt><dd>{review.amount} raw native units</dd>
      <dt>FEE</dt><dd>{review.fee} raw native unit</dd>
      <dt>TOTAL DEBIT</dt><dd>{review.total} raw native units</dd>
    </dl>
    <p className={styles.nativeHint}>This is an on-chain Betanet transaction. Closing a submitted transfer does not cancel it.</p>
    <div className={styles.nativeDialogActions}>
      <button type="button" className={styles.btnSecondary} ref={cancel} onClick={onCancel}>Cancel</button>
      <button type="button" className={styles.btnPrimary} onClick={onConfirm}>Confirm send</button>
    </div>
  </dialog>;
}
