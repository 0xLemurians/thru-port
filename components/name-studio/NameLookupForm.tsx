"use client";

import { utf8ByteLength } from "@/lib/thru/name-service/validation";

interface NameLookupFormProps {
  label: string;
  busy: boolean;
  canRefresh: boolean;
  onLabelChange: (value: string) => void;
  onLookup: () => void;
  onRefresh: () => void;
}

export default function NameLookupForm({
  label,
  busy,
  canRefresh,
  onLabelChange,
  onLookup,
  onRefresh,
}: NameLookupFormProps) {
  const trimmedLabel = label.trim();
  const byteLength = utf8ByteLength(trimmedLabel);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onLookup();
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
            placeholder="mert"
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

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Reading AlphaNet..." : "Look up name"}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy || !canRefresh}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>
    </form>
  );
}

