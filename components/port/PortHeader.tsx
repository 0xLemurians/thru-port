"use client";

import React, { useRef, useEffect } from "react";
import PortMark from "./PortMark";
import PortNetworkStatus from "./PortNetworkStatus";
import type { AlphaNetHealth } from "./useAlphaNetHealth";
import PortWalletPopover from "./PortWalletPopover";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

export type WorkspaceStage = "account" | "token" | "name";

interface PortHeaderProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  publicAddress?: string | null;
  onStageChange: (stage: WorkspaceStage) => void;
  isTransitioning: boolean;
  health: AlphaNetHealth;
  account?: ThruAccount | null;
  balance?: bigint | null;
  onForgetAccount?: () => void | Promise<void>;
}

const ITEMS: Array<{ id: WorkspaceStage; label: string }> = [
  { id: "account", label: "Dashboard" },
  { id: "token", label: "Tokens" },
  { id: "name", label: "Identity" },
];

export default function PortHeader({
  currentStage,
  accountAvailable,
  publicAddress,
  onStageChange,
  isTransitioning,
  health,
  account,
  balance,
  onForgetAccount,
}: PortHeaderProps) {
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const shortAddress = publicAddress 
    ? `${publicAddress.slice(0, 4)}...${publicAddress.slice(-4)}`
    : null;

  const desktopWrapperRef = useRef<HTMLDivElement>(null);
  const mobileWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPopoverOpen(false);
    }
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (desktopWrapperRef.current?.contains(target)) return;
      if (mobileWrapperRef.current?.contains(target)) return;
      setPopoverOpen(false);
    }
    if (popoverOpen) {
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [popoverOpen]);

  const handleNav = (id: WorkspaceStage) => {
    if (!accountAvailable && id !== "account") return;
    if (id === currentStage || isTransitioning) return;
    onStageChange(id);
  };

  const navMetrics: Record<WorkspaceStage, { left: number; width: number }> = {
    account: { left: 0, width: 88 },
    token: { left: 92, width: 66 },
    name: { left: 162, width: 70 },
  };

  const activeNavStyle = navMetrics[currentStage] || navMetrics.account;

  return (
    <>
      {/* Desktop Header */}
      <header className="pc-header" style={{ zIndex: 110 }}>
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

          <div ref={desktopWrapperRef} className="pc-header-right" style={{ position: "relative" }}>
            <PortNetworkStatus status={health.status} />
            <button
              type="button"
              className={`pc-wallet-status pc-wallet-status-btn${popoverOpen ? " active" : ""}`}
              aria-expanded={popoverOpen}
              aria-haspopup="dialog"
              onClick={() => {
                if (account) setPopoverOpen(!popoverOpen);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                background: account ? (popoverOpen ? "rgba(255,123,66,0.12)" : "rgba(255,255,255,0.04)") : "none",
                border: account ? (popoverOpen ? "1px solid rgba(255,123,66,0.4)" : "1px solid rgba(255,255,255,0.10)") : "none",
                borderRadius: "6px",
                cursor: account ? "pointer" : "default",
                padding: account ? "4px 8px" : "0",
                font: "inherit",
                color: popoverOpen ? "var(--accent)" : "inherit",
                fontSize: "12px",
                transition: "background 150ms, border-color 150ms, color 150ms",
              }}
            >
              {/* Wallet icon */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                <line x1="1" y1="10" x2="23" y2="10"/>
              </svg>
              <span>{accountAvailable ? shortAddress : "No wallet"}</span>
              {/* Chevron */}
              {account && (
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ transition: "transform 150ms", transform: popoverOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              )}
            </button>
            {popoverOpen && account && (
              <PortWalletPopover
                account={account}
                balance={balance ?? null}
                health={health}
                onForgetAccount={onForgetAccount}
              />
            )}
          </div>
        </div>
      </header>

      {/* Mobile Header */}
      <header className="pc-mobile-header" style={{ zIndex: 110 }}>
        <span className="pc-brand-name">THRU ALPHANET</span>
        <div ref={mobileWrapperRef} style={{ display: "flex", gap: "12px", alignItems: "center" }}>
           <PortNetworkStatus status={health.status} />
           <button
             type="button"
             className={`pc-wallet-status pc-wallet-status-btn${popoverOpen ? " active" : ""}`}
             aria-expanded={popoverOpen}
             aria-haspopup="dialog"
             style={{
               display: "inline-flex",
               alignItems: "center",
               gap: "4px",
               fontSize: "11px",
               background: account ? (popoverOpen ? "rgba(255,123,66,0.12)" : "rgba(255,255,255,0.04)") : "none",
               border: account ? (popoverOpen ? "1px solid rgba(255,123,66,0.4)" : "1px solid rgba(255,255,255,0.10)") : "none",
               borderRadius: "5px",
               cursor: account ? "pointer" : "default",
               padding: account ? "3px 6px" : "0",
               font: "inherit",
               color: popoverOpen ? "var(--accent)" : "inherit",
               transition: "background 150ms, border-color 150ms, color 150ms",
             }}
             onClick={() => {
               if (account) setPopoverOpen(!popoverOpen);
             }}
           >
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
               <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
               <line x1="1" y1="10" x2="23" y2="10"/>
             </svg>
             <span>{accountAvailable ? shortAddress : "No wallet"}</span>
             {account && (
               <svg
                 width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                 aria-hidden="true"
                 style={{ transition: "transform 150ms", transform: popoverOpen ? "rotate(180deg)" : "rotate(0deg)" }}
               >
                 <polyline points="6 9 12 15 18 9"/>
               </svg>
             )}
           </button>
           {popoverOpen && account && (
             <PortWalletPopover
               account={account}
               balance={balance ?? null}
               health={health}
               onForgetAccount={onForgetAccount}
             />
           )}
        </div>
      </header>
    </>
  );
}
