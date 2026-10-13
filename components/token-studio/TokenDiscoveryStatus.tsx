"use client";

import React from "react";
import type { TokenPortfolioHook } from "@/lib/token/portfolio-hook";
import type { NetworkStatus } from "@/lib/network/network-health";
import styles from "../command/command.module.css";

export default function TokenDiscoveryStatus({ portfolio, status }: { portfolio: TokenPortfolioHook; status?: NetworkStatus }) {
  const blocked = status === "Offline" || status === "Checking";
  const result = portfolio.discovery;
  const label = status === "Offline" ? "RPC unavailable · cached holdings only"
    : status === "Checking" ? "Checking RPC · cached holdings only"
    : portfolio.refreshing ? "Discovering token accounts…"
    : result?.state === "exhausted" ? "Scan complete for available RPC inventory"
    : result?.state === "partial" ? "Partial scan · more accounts may exist"
    : result?.state === "unavailable" ? "RPC inventory unavailable · previous holdings retained"
    : "Cached / stale · live ownership not confirmed";
  return <div aria-label="Token discovery" style={{ margin: "8px 0", fontSize: "0.75rem", color: "var(--text-muted)", overflowWrap: "anywhere" }}>
    <p role="status" aria-live="polite">{label}</p>
    {result && <p>{result.pagesInspected} pages · {result.accountsInspected} candidates · {result.candidateReadFailures} unresolved reads</p>}
    {portfolio.discoveryWarning && <p role="status">{portfolio.discoveryWarning}</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button type="button" className={styles.activityAction} disabled={blocked || portfolio.refreshing}
        onClick={() => { if (!blocked && !portfolio.refreshing) void portfolio.refreshRecords(portfolio.records); }}>Refresh discovery</button>
      {result?.continuation && portfolio.continueDiscovery && <button type="button" className={styles.activityAction}
        disabled={blocked || portfolio.refreshing} onClick={() => { if (!blocked && !portfolio.refreshing) portfolio.continueDiscovery?.(); }}>Continue discovery</button>}
    </div>
    <p>Bounded read-only scan; not a guarantee that all on-chain tokens were found.</p>
  </div>;
}
