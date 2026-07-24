"use client";

import React from "react";
import PortMark from "./PortMark";
import PortNetworkStatus from "./PortNetworkStatus";
import type { AlphaNetHealth } from "./useAlphaNetHealth";

export type WorkspaceStage = "account" | "token" | "name" | "editor";

interface PortHeaderProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  publicAddress?: string | null;
  onStageChange: (stage: WorkspaceStage) => void;
  isTransitioning: boolean;
  health: AlphaNetHealth;
}

const ITEMS: Array<{ id: WorkspaceStage; label: string }> = [
  { id: "account", label: "Dashboard" },
  { id: "token", label: "Tokens" },
  { id: "name", label: "Identity" },
  { id: "editor", label: "Developer" },
];

export default function PortHeader({
  currentStage,
  accountAvailable,
  publicAddress,
  onStageChange,
  isTransitioning,
  health,
}: PortHeaderProps) {
  const shortAddress = publicAddress 
    ? `${publicAddress.slice(0, 4)}...${publicAddress.slice(-4)}`
    : null;

  const handleNav = (id: WorkspaceStage) => {
    if (!accountAvailable && id !== "account") return;
    if (id === currentStage || isTransitioning) return;
    onStageChange(id);
  };

  const navMetrics: Record<WorkspaceStage, { left: number; width: number }> = {
    account: { left: 0, width: 88 },
    token: { left: 92, width: 66 },
    name: { left: 162, width: 70 },
    editor: { left: 236, width: 82 },
  };

  const activeNavStyle = navMetrics[currentStage] || navMetrics.account;

  return (
    <>
      {/* Desktop Header */}
      <header className="pc-header">
        <div className="pc-header-inner">
          <div className="pc-header-left">
            <div className="pc-brand">
              <PortMark />
              <span className="pc-brand-name">THRU ALPHANET</span>
            </div>

            <div className="pc-v-divider" />

            <nav className="pc-nav">
              <div 
                className="pc-nav-indicator" 
                style={{ 
                  left: activeNavStyle.left, 
                  width: activeNavStyle.width,
                  display: !accountAvailable && currentStage !== "account" ? "none" : "block"
                }} 
              />
              {ITEMS.map((item) => {
                const isLocked = !accountAvailable && item.id !== "account";
                return (
                  <button
                    key={item.id}
                    className={`pc-nav-btn ${currentStage === item.id ? "active" : ""} ${isLocked ? "locked" : ""}`}
                    style={{ cursor: isLocked ? "not-allowed" : "pointer" }}
                    onClick={() => handleNav(item.id)}
                    title={isLocked ? "Create or import a wallet to unlock this workspace." : ""}
                  >
                    <span style={{ position: "relative", paddingLeft: isLocked ? "14px" : "0", transition: "padding 300ms ease" }}>
                      <svg 
                        style={{ position: "absolute", left: 0, top: "2px", opacity: isLocked ? 1 : 0, transition: "opacity 300ms ease", width: "10px", height: "10px" }} 
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      >
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="pc-header-right">
            <PortNetworkStatus status={health.status} />
            <span className="pc-wallet-status">
              {accountAvailable ? shortAddress : "No wallet"}
            </span>
          </div>
        </div>
      </header>

      {/* Mobile Header */}
      <header className="pc-mobile-header">
        <span className="pc-brand-name">THRU ALPHANET</span>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
           <PortNetworkStatus status={health.status} />
           <span className="pc-wallet-status" style={{ fontSize: "11px" }}>
             {accountAvailable ? shortAddress : "No wallet"}
           </span>
        </div>
      </header>
    </>
  );
}
