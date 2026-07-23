"use client";

export type WorkspaceStage = "account" | "token" | "editor";

interface WorkspaceNavProps {
  current: WorkspaceStage;
  onChange: (stage: WorkspaceStage) => void;
  disabled?: boolean;
}

const ITEMS: Array<{
  id: WorkspaceStage;
  label: string;
  experimental?: boolean;
}> = [
  { id: "account", label: "Wallet & Faucet" },
  { id: "token", label: "Token Studio", experimental: true },
  { id: "editor", label: "Build" },
];

export default function WorkspaceNav({
  current,
  onChange,
  disabled = false,
}: WorkspaceNavProps) {
  return (
    <nav className="workspace-nav" aria-label="Workspace">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          className={
            current === item.id
              ? "workspace-nav-item workspace-nav-item-active"
              : "workspace-nav-item"
          }
          type="button"
          disabled={disabled}
          aria-current={current === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
        >
          <span>{item.label}</span>
          {item.experimental && (
            <span className="workspace-nav-tag">Experimental</span>
          )}
        </button>
      ))}
    </nav>
  );
}
