"use client";

import React, { useEffect, useState } from "react";

export default function PortThruCore() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={`pc-wallet-core ${loaded ? "loaded" : ""}`}>
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle className="pc-core-ring pc-core-ring-1" cx="32" cy="32" r="28" stroke="rgba(244,122,60,0.15)" strokeWidth="1" />
        <circle className="pc-core-ring pc-core-ring-2" cx="32" cy="32" r="22" stroke="rgba(244,122,60,0.25)" strokeWidth="1" strokeDasharray="4 4" />
        <circle className="pc-core-ring pc-core-ring-3" cx="32" cy="32" r="16" stroke="rgba(244,122,60,0.4)" strokeWidth="1.5" />
        <circle className="pc-core-glow" cx="32" cy="32" r="8" fill="#F47A3C" />
      </svg>
    </div>
  );
}
