"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityRequestSequence,
  loadActivityPage,
  uniqueActivityEntries,
  type ActivityEntry,
} from "@/lib/thru/activity";
import { explorerTransactionUrl, NETWORK_RPC_DEGRADED_MESSAGE, NETWORK_RPC_UNAVAILABLE_MESSAGE } from "@/lib/thru/network";
import type { NetworkStatus } from "@/lib/network/network-health";
import styles from "./command.module.css";

interface CommandActivityProps {
  walletAddress: string;
  networkStatus: NetworkStatus;
  refreshRevision?: number;
}

const HISTORY_ERROR = "Betanet transaction history is temporarily unavailable. Try again later.";
const HISTORY_TIMEOUT_MS = 20_000;

function shortSignature(signature: string): string {
  return signature.length > 22 ? `${signature.slice(0, 12)}…${signature.slice(-8)}` : signature;
}

export default function CommandActivity({ walletAddress, networkStatus, refreshRevision = 0 }: CommandActivityProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(new ActivityRequestSequence());
  const activeRequest = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const load = useCallback(async (pageToken: string | null, append: boolean) => {
    if (networkStatus === "Offline" || networkStatus === "Checking" || busy.current) return;
    busy.current = true;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const generation = sequence.current.begin();
    const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    try {
      const page = await loadActivityPage(walletAddress, pageToken, undefined, controller.signal);
      if (!sequence.current.isCurrent(generation) || controller.signal.aborted) return;
      setEntries((previous) => append ? uniqueActivityEntries(previous, page.entries) : page.entries);
      setNextPageToken(page.nextPageToken === pageToken ? null : page.nextPageToken);
    } catch {
      if (sequence.current.isCurrent(generation) && !controller.signal.aborted) setError(HISTORY_ERROR);
      if (sequence.current.isCurrent(generation) && controller.signal.aborted) setError(HISTORY_ERROR);
    } finally {
      clearTimeout(timer);
      if (sequence.current.isCurrent(generation)) {
        setLoading(false);
        busy.current = false;
        activeRequest.current = null;
      }
    }
  }, [networkStatus, walletAddress]);

  useEffect(() => {
    const currentSequence = sequence.current;
    if (networkStatus === "Offline" || networkStatus === "Checking") {
      activeRequest.current?.abort();
      currentSequence.invalidate();
      busy.current = false;
      setEntries([]);
      setNextPageToken(null);
      setError(null);
      setLoading(false);
    } else {
      void load(null, false);
    }
    return () => {
      activeRequest.current?.abort();
      currentSequence.invalidate();
      busy.current = false;
    };
  }, [networkStatus, load, refreshRevision]);

  const unavailable = networkStatus === "Offline" || networkStatus === "Checking";
  const message = networkStatus === "Offline"
    ? NETWORK_RPC_UNAVAILABLE_MESSAGE
    : networkStatus === "Checking"
      ? "Checking Betanet RPC before loading activity…"
      : error;

  return (
    <section className={styles.gridBlockActivity} aria-label="Recent on-chain activity">
      <div className={styles.activityHeader}>
        <h4 className={styles.blockTitle}>Recent Activity</h4>
        <button type="button" className={styles.activityAction} disabled={unavailable || loading} onClick={() => void load(null, false)}>
          Refresh
        </button>
      </div>
      {networkStatus === "Degraded" && <p className={styles.activityWarning}>{NETWORK_RPC_DEGRADED_MESSAGE}</p>}
      <div role="status" aria-live="polite" className={styles.activityMessage}>
        {message ?? (loading && entries.length === 0 ? "Loading Betanet activity…" : null)}
      </div>
      {!unavailable && entries.length === 0 && !loading && !error && (
        <p className={styles.activityEmpty}>No transactions found in the available RPC history.</p>
      )}
      {!unavailable && entries.length > 0 && (
        <ul className={styles.activityList}>
          {entries.map((entry) => (
            <li className={styles.actItem} key={entry.signature}>
              <div className={styles.actLeft}>
                <span className={styles.actType}>{entry.type}</span>
                <span className={styles.actMeta}>
                  {entry.timestampMs === null ? "Time unavailable" : new Date(entry.timestampMs).toLocaleString()}
                  {" · "}{entry.status}
                </span>
                <a className={styles.activityLink} href={explorerTransactionUrl(entry.signature)} target="_blank" rel="noopener noreferrer" aria-label={`View transaction ${entry.signature} on Betanet Explorer`}>
                  {shortSignature(entry.signature)} ↗
                </a>
              </div>
              {entry.amount && (
                <span className={`${styles.actAmount} ${entry.direction === "incoming" ? styles.actPositive : ""}`}>
                  {entry.direction === "incoming" ? "+" : entry.direction === "outgoing" ? "−" : ""}{entry.amount}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!unavailable && nextPageToken && (
        <button type="button" className={styles.activityAction} disabled={loading} onClick={() => void load(nextPageToken, true)}>
          {loading ? "Loading…" : "Load More"}
        </button>
      )}
      <p className={styles.activityFootnote}>Recent on-chain results only; Betanet RPC may not retain complete history.</p>
    </section>
  );
}
