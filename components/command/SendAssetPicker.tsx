"use client";

import React, { useId } from "react";
import { NATIVE_ASSET_LABEL, NATIVE_ASSET_VALUE } from "@/lib/wallet/native-transfer-controller";
import styles from "./command.module.css";

export interface SendAssetPickerProps {
  value: string; disabled: boolean; options: { value: string; label: string }[];
  onChange: (value: string) => void;
}
export function selectSendAsset(props: SendAssetPickerProps, value: string) {
  if (!props.disabled && (value === NATIVE_ASSET_VALUE || props.options.some((item) => item.value === value))) props.onChange(value);
}
export default function SendAssetPicker(props: SendAssetPickerProps) {
  const id = useId();
  return <div className={styles.inputGroup}>
    <label className={styles.inputLabel} htmlFor={id}>Asset</label>
    <select id={id} className={styles.inputSelect} value={props.value} disabled={props.disabled}
      onChange={(event) => selectSendAsset(props, event.target.value)}>
      <option value={NATIVE_ASSET_VALUE}>{NATIVE_ASSET_LABEL}</option>
      {!props.value && <option value="">Select an asset</option>}
      {props.options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  </div>;
}
