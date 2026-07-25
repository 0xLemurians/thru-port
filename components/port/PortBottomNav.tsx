"use client";

import React from "react";
import type { WorkspaceStage } from "./PortHeader";

interface PortBottomNavProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  onStageChange: (stage: WorkspaceStage) => void;
  isTransitioning: boolean;
}

const ITEMS: Array<{ id: WorkspaceStage; label: string }> = [
  { id: "account", label: "Dashboard" },
  { id: "token", label: "Tokens" },
  { id: "name", label: "Identity" },
];

export default function PortBottomNav({
  currentStage,
  accountAvailable,
  onStageChange,
  isTransitioning,
}: PortBottomNavProps) {
  const handleNav = (id: WorkspaceStage) => {
    if (!accountAvailable && id !== "account") return;
    if (id === currentStage || isTransitioning) return;
    onStageChange(id);
  };

  const navMetrics: Record<WorkspaceStage, { left: number; width: number }> = {
    account: { left: 0, width: 33.33 },
    token: { left: 33.33, width: 33.33 },
    name: { left: 66.66, width: 33.33 },
  };

  const activeNavStyle = navMetrics[currentStage] || navMetrics.account;

  return (
    <nav className="pc-mobile-nav">
      {ITEMS.map((item) => {
        const isLocked = !accountAvailable && item.id !== "account";
        return (
          <button
            key={item.id}
            className={`pc-mob-nav-btn ${currentStage === item.id ? "active" : ""} ${isLocked ? "locked" : ""}`}
            onClick={() => handleNav(item.id)}
            title={isLocked ? "Create or import a wallet to unlock this workspace." : ""}
          >
            {isLocked ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 4 }}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              <span>{item.label}</span>
            )}
          </button>
        );
      })}
      <div
        className="pc-mob-indicator"
        style={{ 
          left: `${activeNavStyle.left}%`, 
          width: `${activeNavStyle.width}%`,
          display: !accountAvailable && currentStage !== "account" ? "none" : "block"
        }}
      />
    </nav>
  );
}
