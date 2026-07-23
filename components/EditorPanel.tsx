"use client";

import { useEffect, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import { TEMPLATES, getTemplate } from "@/lib/templates";
import Stepper from "./Stepper";

interface EditorPanelProps {
  accountAddress: string;
  onBack: () => void;
  onForgetAccount: () => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function EditorPanel({
  accountAddress,
  onBack,
  onForgetAccount,
}: EditorPanelProps) {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [editorRuntime, setEditorRuntime] = useState<
    "loading" | "ready" | "error"
  >("loading");

  useEffect(() => {
    let active = true;
    void import("monaco-editor")
      .then((monaco) => {
        loader.config({ monaco });
        if (active) setEditorRuntime("ready");
      })
      .catch(() => {
        if (active) setEditorRuntime("error");
      });
    return () => {
      active = false;
    };
  }, []);

  function pickTemplate(id: string) {
    setTemplateId(id);
    setSource(getTemplate(id).source);
  }

  function changeTemplate() {
    if (
      templateId &&
      source !== getTemplate(templateId).source &&
      !window.confirm("Discard your unsaved edits and choose another template?")
    ) {
      return;
    }
    setTemplateId(null);
    setSource("");
  }

  if (!templateId) {
    return (
      <>
        <Stepper current={3} />
        <div className="panel">
          <div className="editor-header">
            <div>
              <h2 className="panel-title">Pick a starting point</h2>
              <p className="account-chip mono" title={accountAddress}>
                {shortAddress(accountAddress)}
              </p>
            </div>
            <button className="btn btn-ghost" type="button" onClick={onBack}>
              ← Account
            </button>
          </div>
          <p className="panel-sub">
            These templates target the Thru C SDK. Build and on-chain execution
            validation will be added in a later stage.
          </p>
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className="template-card"
                type="button"
                onClick={() => pickTemplate(t.id)}
              >
                <span className="template-name">{t.name}</span>
                <span className="template-desc">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Stepper current={3} />
      <div className="panel panel-editor">
        <div className="editor-header">
          <div>
            <h2 className="panel-title" style={{ marginBottom: 2 }}>
              {getTemplate(templateId).name}
            </h2>
              <p className="hint" style={{ margin: 0 }}>
                {getTemplate(templateId).description}
              </p>
              <p className="template-meta mono">
                {getTemplate(templateId).fileName} · state{" "}
                {getTemplate(templateId).accountDataBytes} bytes ·{" "}
                {getTemplate(templateId).instructionFormat}
              </p>
          </div>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={changeTemplate}
          >
            Change template
          </button>
        </div>

        <div className="editor-frame">
          {editorRuntime === "ready" && (
            <Editor
              height="420px"
              defaultLanguage="c"
              theme="vs-dark"
              value={source}
              onChange={(value) => setSource(value ?? "")}
              path={getTemplate(templateId).fileName}
              loading={<p className="editor-loading">Loading local editor…</p>}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                padding: { top: 16 },
                automaticLayout: true,
                tabSize: 2,
              }}
            />
          )}
          {editorRuntime === "loading" && (
            <p className="editor-loading">Loading local editor…</p>
          )}
          {editorRuntime === "error" && (
            <p className="editor-error">
              The local editor could not be loaded. Refresh the page to try
              again.
            </p>
          )}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" disabled>
            Build (not available yet)
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={source === getTemplate(templateId).source}
            onClick={() => setSource(getTemplate(templateId).source)}
          >
            Reset template
          </button>
          <button className="btn btn-link danger-link" type="button" onClick={onForgetAccount}>
            Forget account on this device
          </button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Editing is local to this tab. Build and deploy are not connected yet.
        </p>
      </div>
    </>
  );
}
