"use client";

import React, { useState, useEffect } from "react";
import type { WorkspaceStage } from "../port/PortHeader";
import type { AlphaNetHealth } from "../port/useAlphaNetHealth";
import styles from "./command.module.css";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";

interface CommandShellProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  publicAddress?: string | null;
  onStageChange: (stage: WorkspaceStage) => void;
  health: AlphaNetHealth;
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
        <button type="button" className={styles.hamburgerBtn} onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
          ☰
        </button>
      </div>

      {/* Left Navigation Rail */}
      <nav className={`${styles.navRail} ${isMobileMenuOpen ? styles.navRailOpen : ''}`}>
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
            
            <a href="#" className={styles.navLinkSecondary}>
              <span className={styles.navIconSecondary}>⌘</span>
              <span className={styles.navLabelSecondary}>Docs</span>
            </a>
            <a href="#" className={styles.navLinkSecondary}>
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
