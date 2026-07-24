"use client";

import React, { useState, useEffect } from "react";
import type { WorkspaceStage } from "./PortHeader";
import PortHeader from "./PortHeader";
import PortBottomNav from "./PortBottomNav";
import type { AlphaNetHealth } from "./useAlphaNetHealth";

interface PortShellProps {
  currentStage: WorkspaceStage;
  accountAvailable: boolean;
  publicAddress?: string | null;
  onStageChange: (stage: WorkspaceStage) => void;
  health: AlphaNetHealth;
  children: React.ReactNode;
}

export default function PortShell({
  currentStage,
  accountAvailable,
  publicAddress,
  onStageChange,
  health,
  children,
}: PortShellProps) {
  const [displayStage, setDisplayStage] = useState<WorkspaceStage>(currentStage);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [swipeActive, setSwipeActive] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setInitialLoad(false), 50);
    return () => clearTimeout(t);
  }, []);

  // Sync if currentStage changes externally (e.g., wallet reset)
  useEffect(() => {
    if (currentStage !== displayStage && !isTransitioning) {
      handleStageChange(currentStage);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage]);

  const handleStageChange = (newStage: WorkspaceStage) => {
    if (newStage === displayStage || isTransitioning) return;
    setIsTransitioning(true);
    setSwipeActive(true);

    setTimeout(() => {
      setDisplayStage(newStage);
      onStageChange(newStage);
    }, 130);

    setTimeout(() => {
      setIsTransitioning(false);
      setSwipeActive(false);
    }, 420);
  };

  return (
    <div className={`pc ${initialLoad ? "pre-load" : "loaded"}`}>
      <div className="pc-root">
        {/* Atmosphere Layer */}
        <div className="pc-bg" aria-hidden="true">
          <div className="pc-bg-tr" />
          <div className="pc-bg-bl" />
          <div className="pc-bg-c" />
          <div className="pc-bg-vignette" />
          
          <div className="pc-bg-watermark">
            <svg viewBox="0 0 200 200" width="100%" height="100%" className="pc-watermark-spin">
               <path d="M 100 10 A 90 90 0 1 1 10 100" fill="none" stroke="#F47A3C" strokeWidth="0.5" />
               <path d="M 100 30 A 70 70 0 1 0 170 100" fill="none" stroke="#D8A15D" strokeWidth="0.5" />
               <circle cx="100" cy="10" r="1.5" fill="#F47A3C" />
               <circle cx="170" cy="100" r="1.5" fill="#D8A15D" />
               <circle cx="10" cy="100" r="1.5" fill="#D8A15D" />
            </svg>
          </div>
        </div>

        <div className={`pc-copper-swipe ${swipeActive ? "active" : ""}`} />

        <PortHeader
          currentStage={currentStage} // keep immediate selection visually
          accountAvailable={accountAvailable}
          publicAddress={publicAddress}
          onStageChange={handleStageChange}
          isTransitioning={isTransitioning}
          health={health}
        />

        <main className="pc-workspace">
          <div className={`pc-content pc-page-content ${isTransitioning ? "transitioning" : ""}`}>
            {/* The child component (PortDashboard, TokenStudio, etc) is rendered here. 
                PortDashboard itself handles the layout since the SafetyRail needs to be below the center content.
                We wrap children in a keyed div just like prototype for React reconcilation cleanliness. */}
            <div key={displayStage} style={{ width: "100%" }}>
              {children}
            </div>
          </div>
        </main>

        <PortBottomNav 
          currentStage={currentStage}
          accountAvailable={accountAvailable}
          onStageChange={handleStageChange}
          isTransitioning={isTransitioning}
        />
      </div>
    </div>
  );
}
