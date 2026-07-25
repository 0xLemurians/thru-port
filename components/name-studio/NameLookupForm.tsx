"use client";

import {
  ALPHANET_RPC_DEGRADED_MESSAGE,
  ALPHANET_RPC_UNAVAILABLE_MESSAGE,
} from "@/lib/thru/name-service/constants";
import { utf8ByteLength } from "@/lib/thru/name-service/validation";
import type { NetworkStatus } from "../port/useAlphaNetHealth";

interface NameLookupFormProps {
  label: string;
  busy: boolean;
  canRefresh: boolean;
  networkStatus: NetworkStatus;
  onLabelChange: (value: string) => void;
  onLookup: () => void;
  onRefresh: () => void;
}

export function nameLookupActionsDisabled(
  busy: boolean,
  networkStatus: NetworkStatus,
): boolean {
  return busy || networkStatus === "Offline";
}

export function invokeNameLookupAction(
  action: () => void,
  busy: boolean,
  networkStatus: NetworkStatus,
): boolean {
  if (nameLookupActionsDisabled(busy, networkStatus)) return false;
  action();
  return true;
}

export default function NameLookupForm({
  label,
  busy,
  canRefresh,
  networkStatus,
  onLabelChange,
  onLookup,
  onRefresh,
}: NameLookupFormProps) {
  const trimmedLabel = label.trim();
  const byteLength = utf8ByteLength(trimmedLabel);
  const actionsDisabled = nameLookupActionsDisabled(busy, networkStatus);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invokeNameLookupAction(onLookup, busy, networkStatus);
  }

  return (
    <form className="name-lookup-form" onSubmit={submit}>
      <label className="form-field name-label-field">
        <span className="field-label">.thru label</span>
        <div className="name-input-wrap">
          <input
            className="input mono"
            type="text"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            disabled={busy}
            placeholder="Enter label"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="name-label-help name-label-preview"
          />
          <span className="name-input-suffix" aria-hidden="true">
            .thru
          </span>
        </div>
        <span className="hint" id="name-label-help">
          Enter only the label. Derivation uses the trimmed label&apos;s raw
          UTF-8 bytes without case conversion or Unicode normalization.
        </span>
        <span
          className="name-label-preview mono"
          id="name-label-preview"
        >
          Lookup: {trimmedLabel || "label"}.thru · {byteLength}/64 UTF-8
          bytes
        </span>
      </label>

      {networkStatus === "Offline" && (
        <p
          className="name-network-message name-network-offline"
          role="status"
        >
          {ALPHANET_RPC_UNAVAILABLE_MESSAGE}
        </p>
      )}
      {networkStatus === "Degraded" && (
        <p className="name-network-message" role="status">
          {ALPHANET_RPC_DEGRADED_MESSAGE}
        </p>
      )}

      <div className="row">
        <button
          className="btn btn-primary name-lookup-action"
          type="submit"
          disabled={actionsDisabled}
        >
          {busy ? "Reading AlphaNet..." : "Look up name"}
        </button>
        <button
          className="btn btn-ghost name-lookup-action"
          type="button"
          disabled={actionsDisabled || !canRefresh}
          onClick={() =>
            invokeNameLookupAction(onRefresh, busy, networkStatus)
          }
        >
          Refresh
        </button>
      </div>
    </form>
  );
}

