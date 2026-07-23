"use client";

import { useEffect, useRef, useState } from "react";
import type { NameLookupSnapshot } from "@/lib/thru/name-service/account-types";
import {
  LatestNameLookupTracker,
  lookupThruName,
} from "@/lib/thru/name-service/lookup";
import LeaseDetails from "./name-studio/LeaseDetails";
import NameAccountDetails from "./name-studio/NameAccountDetails";
import NameLookupForm from "./name-studio/NameLookupForm";
import NameSecurityNotice from "./name-studio/NameSecurityNotice";

export default function NameStudio() {
  const [label, setLabel] = useState("");
  const [snapshot, setSnapshot] = useState<NameLookupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const trackerRef = useRef(new LatestNameLookupTracker());

  useEffect(() => {
    const tracker = trackerRef.current;
    return () => {
      tracker.invalidate();
      controllerRef.current?.abort();
    };
  }, []);

  async function runLookup(value: string) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = trackerRef.current.begin();
    setBusy(true);
    setError(null);

    try {
      const next = await lookupThruName(value, {
        signal: controller.signal,
      });
      if (!trackerRef.current.isCurrent(request)) return;
      setLabel(next.label);
      setSnapshot(next);
    } catch (caught) {
      if (!trackerRef.current.isCurrent(request)) return;
      if (controller.signal.aborted) return;
      setError(
        caught instanceof Error ? caught.message : "Name lookup failed.",
      );
    } finally {
      if (trackerRef.current.isCurrent(request)) {
        setBusy(false);
      }
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }

  return (
    <div className="panel name-studio">
      <div className="name-studio-header">
        <div>
          <p className="eyebrow token-eyebrow">Name Studio · Read only</p>
          <h2 className="panel-title">Inspect .thru names on AlphaNet</h2>
        </div>
        <span className="workspace-nav-tag">No wallet required</span>
      </div>

      <p className="panel-sub">
        Derive and inspect the official Registrar config, domain account,
        lease account, and records. This screen only performs RPC reads.
      </p>

      <NameSecurityNotice />

      <NameLookupForm
        label={label}
        busy={busy}
        canRefresh={Boolean(snapshot)}
        onLabelChange={setLabel}
        onLookup={() => void runLookup(label)}
        onRefresh={() => {
          if (snapshot) void runLookup(snapshot.label);
        }}
      />

      {error && (
        <p className="token-error" role="alert">
          {error}
        </p>
      )}

      {snapshot && (
        <div className="name-results" aria-live="polite">
          <NameAccountDetails snapshot={snapshot} />
          <LeaseDetails snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}

