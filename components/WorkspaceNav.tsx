"use client";

export type WorkspaceStage = "account" | "token" | "name" | "editor";

interface WorkspaceNavProps {
  current: WorkspaceStage;
  onChange: (stage: WorkspaceStage) => void;
  disabled?: boolean;
  accountAvailable?: boolean;
}

const ITEMS: Array<{
  id: WorkspaceStage;
  label: string;
  tag?: string;
  requiresAccount?: boolean;
}> = [
  { id: "account", label: "Wallet & Faucet" },
  {
    id: "token",
    label: "Token Studio",
    tag: "Experimental",
    requiresAccount: true,
  },
  { id: "name", label: "Name Studio", tag: "Read only" },
  { id: "editor", label: "Build", requiresAccount: true },
];

export default function WorkspaceNav({
  current,
  onChange,
  disabled = false,
  accountAvailable = false,
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
          disabled={
            disabled || (item.requiresAccount && !accountAvailable)
          }
          aria-current={current === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
          title={
            item.requiresAccount && !accountAvailable
              ? "Create or import a wallet first"
              : undefined
          }
        >
          <span>{item.label}</span>
          {item.tag && (
            <span className="workspace-nav-tag">{item.tag}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
