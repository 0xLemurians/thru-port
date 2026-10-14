"use client";

import React, { useState, useEffect, useId, useRef } from "react";
import type { WorkspaceStage } from "../port/PortHeader";
import type { NetworkHealth } from "../port/useNetworkHealth";
import styles from "./command.module.css";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import { explorerHomeUrl, THRU_NETWORK } from "@/lib/thru/network";

interface CommandShellProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  publicAddress?: string | null;
  onStageChange: (stage: WorkspaceStage) => void;
  health: NetworkHealth;
  account?: ThruAccount | null;
  balance?: bigint | null;
  onForgetAccount?: () => void | Promise<void>;
  children: React.ReactNode;
}

export default function CommandShell({
  currentStage,
  accountAvailable,
  onStageChange,
  children,
}: CommandShellProps) {
  const [mounted, setMounted] = useState(false);
  const [colorMode, setColorMode] = useState<"dark" | "light">("dark");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const navigationId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      const savedColor = localStorage.getItem("thru-port-color-mode");
      if (savedColor === "light" || savedColor === "dark") {
        setColorMode(savedColor);
        document.documentElement.setAttribute('data-theme', savedColor);
      } else {
        document.documentElement.setAttribute('data-theme', "dark");
      }
    } catch {
      document.documentElement.setAttribute('data-theme', "dark");
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const trigger = menuButtonRef.current;
      const activeElement = document.activeElement;
      const restoreFocus = activeElement === trigger || navigationRef.current?.contains(activeElement);
      setIsMobileMenuOpen(false);
      // Do not steal focus from an unrelated field or a hidden desktop trigger.
      if (restoreFocus && trigger && trigger.getClientRects().length > 0) trigger.focus();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isMobileMenuOpen]);

  const toggleColorMode = () => {
    const newMode = colorMode === "dark" ? "light" : "dark";
    setColorMode(newMode);
    document.documentElement.setAttribute('data-theme', newMode);
    try {
      localStorage.setItem("thru-port-color-mode", newMode);
    } catch {}
  };

  if (!mounted) {
    return <div style={{ visibility: "hidden", minHeight: "100vh", backgroundColor: "var(--page-bg)" }} />;
  }

  return (
    <div className={`${styles.container} ${styles.cmdRoot}`}>
      {/* Top Mobile Bar */}
      <div className={styles.mobileTopBar}>
        <div className={styles.logoGroupMobile}>
           <div className={styles.logoIcon}>T</div>
           <span className={styles.logoText}>Port</span>
        </div>
        <button type="button" ref={menuButtonRef} className={styles.hamburgerBtn}
          aria-label={isMobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={isMobileMenuOpen} aria-controls={navigationId}
          onClick={() => setIsMobileMenuOpen((open) => !open)}>
          <span aria-hidden="true">☰</span>
        </button>
      </div>

      {/* Left Navigation Rail */}
      <nav id={navigationId} ref={navigationRef} aria-label="Main navigation"
        className={`${styles.navRail} ${isMobileMenuOpen ? styles.navRailOpen : ''}`}>
        <div className={styles.navTop}>
          <div className={styles.logoGroup}>
            <div className={styles.logoIcon}>T</div>
          </div>
          
          <div className={styles.navLinks}>
            <button 
              type="button"
              onClick={() => { onStageChange("account"); setIsMobileMenuOpen(false); }} 
              className={`${styles.navLink} ${currentStage === "account" ? styles.active : ""}`}
            >
              <span className={styles.navIcon}>◱</span>
              <span className={styles.navLabel}>Dashboard</span>
            </button>
            <button 
              type="button"
              disabled={!accountAvailable}
              onClick={() => { if(accountAvailable) { onStageChange("token"); setIsMobileMenuOpen(false); } }} 
              className={`${styles.navLink} ${currentStage === "token" ? styles.active : ""}`}
              style={{ opacity: accountAvailable ? 1 : 0.5, cursor: accountAvailable ? "pointer" : "not-allowed" }}
            >
              <span className={styles.navIcon}>⬡</span>
              <span className={styles.navLabel}>Tokens</span>
            </button>
            <button 
              type="button"
              disabled={!accountAvailable}
              onClick={() => { if(accountAvailable) { onStageChange("name"); setIsMobileMenuOpen(false); } }} 
              className={`${styles.navLink} ${currentStage === "name" ? styles.active : ""}`}
              style={{ opacity: accountAvailable ? 1 : 0.5, cursor: accountAvailable ? "pointer" : "not-allowed" }}
            >
              <span className={styles.navIcon}>@</span>
              <span className={styles.navLabel}>Identity</span>
            </button>
            
            <div className={styles.navDivider}></div>
            
            <a href="https://thru.org/docs/" target="_blank" rel="noopener noreferrer" aria-label="Open Thru Documentation" className={styles.navLinkSecondary}>
              <span className={styles.navIconSecondary}>⌘</span>
              <span className={styles.navLabelSecondary}>Docs</span>
            </a>
            <a href={explorerHomeUrl()} target="_blank" rel="noopener noreferrer" aria-label={`Open Thru ${THRU_NETWORK.displayName} Explorer`} className={styles.navLinkSecondary}>
              <span className={styles.navIconSecondary}>↗</span>
              <span className={styles.navLabelSecondary}>Explorer</span>
            </a>
          </div>
        </div>
        
        <div className={styles.navBottom}>
          <button 
            type="button"
            onClick={toggleColorMode}
            className={`${styles.themeBtn} ${styles.colorToggleBtn}`}
            aria-label={`Switch to ${colorMode === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${colorMode === 'dark' ? 'light' : 'dark'} mode`}
          >
            {colorMode === "dark" ? "☀️ Light" : "🌙 Dark"}
          </button>
        </div>
      </nav>

      {/* Workspace Wrapper */}
      <div className={styles.workspace}>
        {children}
      </div>
    </div>
  );
}
