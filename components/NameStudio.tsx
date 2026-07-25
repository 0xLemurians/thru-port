"use client";

import { useEffect, useRef, useState } from "react";
import type { NameLookupSnapshot } from "@/lib/thru/name-service/account-types";
import { ALPHANET_RPC_UNAVAILABLE_MESSAGE } from "@/lib/thru/name-service/constants";
import {
  LatestNameLookupTracker,
  lookupThruName,
} from "@/lib/thru/name-service/lookup";
import { validateNameLabel } from "@/lib/thru/name-service/validation";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import LeaseDetails from "./name-studio/LeaseDetails";
import NameAccountDetails from "./name-studio/NameAccountDetails";
import NameLookupForm from "./name-studio/NameLookupForm";
import NameRegisterForm from "./name-studio/NameRegisterForm";
import NameSecurityNotice from "./name-studio/NameSecurityNotice";
import type { AlphaNetHealth } from "./port/useAlphaNetHealth";

interface NameStudioProps {
  account: ThruAccount;
  health: AlphaNetHealth;
  walletReady: boolean;
}

export default function NameStudio({
  account,
  health,
  walletReady,
}: NameStudioProps) {
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

  useEffect(() => {
    if (health.status !== "Offline") return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    trackerRef.current.invalidate();
    setBusy(false);
    setError(null);
  }, [health.status]);

  async function runLookup(value: string) {
    if (health.status === "Offline") {
      setBusy(false);
      setError(null);
      return;
    }

    let validatedLabel: string;
    try {
      validatedLabel = validateNameLabel(value.trim()).label;
    } catch {
      setError(
        "Enter a valid .thru label with no dots and at most 64 UTF-8 bytes.",
      );
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = trackerRef.current.begin();
    setBusy(true);
    setError(null);

    try {
      const next = await lookupThruName(validatedLabel, {
        signal: controller.signal,
      });
      if (!trackerRef.current.isCurrent(request)) return;
      setLabel(next.label);
      setSnapshot(next);
    } catch {
      if (!trackerRef.current.isCurrent(request)) return;
      if (controller.signal.aborted) return;
      setError(ALPHANET_RPC_UNAVAILABLE_MESSAGE);
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
          <p className="eyebrow token-eyebrow">Identity · .thru names</p>
          <h2 className="panel-title">Register and inspect on AlphaNet</h2>
        </div>
        <span className="workspace-nav-tag">ONE YEAR</span>
      </div>

      <p className="panel-sub">
        Register an available name to the current wallet, or inspect existing
        Registrar, domain, lease, and record state.
      </p>

      <NameSecurityNotice />

      <NameRegisterForm
        account={account}
        health={health}
        walletReady={walletReady}
      />

      <div className="name-inspection-heading">
        <p className="eyebrow token-eyebrow">Read-only lookup</p>
        <h3>Inspect an existing .thru name</h3>
        <p className="hint">
          Lookup remains read-only and never reserves or changes a name.
        </p>
      </div>

      <NameLookupForm
        label={label}
        busy={busy}
        canRefresh={Boolean(snapshot)}
        networkStatus={health.status}
        onLabelChange={(value) => {
          setLabel(value);
          setError(null);
        }}
        onLookup={() => void runLookup(label)}
        onRefresh={() => {
          if (snapshot) void runLookup(snapshot.label);
        }}
      />

      {error && health.status !== "Offline" && (
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

