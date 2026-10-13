"use client";

import React, { useId } from "react";
import { formatRawAmount } from "@thru/programs/token";
import type { TokenPortfolioItem } from "@/lib/token/thru-token";
import { tokenSendSources } from "@/lib/token/portfolio";
import styles from "../command/command.module.css";

export default function TokenSourcePicker({ item, wallet, value, disabled, onChange }: {
  item?: TokenPortfolioItem; wallet: string; value: string; disabled: boolean; onChange: (address: string) => void;
}) {
  const id = useId();
  const sources = tokenSendSources(item, wallet);
  if (sources.length < 2 || !item?.mint) return null;
  const decimals = item.mint.decimals;
  return <label className="form-field" htmlFor={id}>
    <span className={styles.inputLabel}>Balance source · one token account</span>
    <select id={id} aria-label="Balance source · one token account" className={`${styles.inputSelect} mono`} value={sources.some((source) => source.address === value) ? value : sources[0].address}
      disabled={disabled} onChange={(event) => { if (!disabled && sources.some((source) => source.address === event.target.value)) onChange(event.target.value); }}>
      {sources.map((source) => <option key={source.address} value={source.address}>
        {source.address.slice(0, 10)}…{source.address.slice(-6)} · {source.state ? formatRawAmount(source.state.amount, decimals) : "Unavailable"}
      </option>)}
    </select>
  </label>;
}
