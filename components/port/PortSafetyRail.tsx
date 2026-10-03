"use client";

import React from "react";
import { THRU_NETWORK } from "@/lib/thru/network";

export default function PortSafetyRail() {
  return (
    <div className="pc-safety-rail pc-anim-safety-rail">
      <div className="pc-sr-item pc-anim-mask" style={{ animationDelay: "100ms" }}>
        <span className="pc-sr-title">{THRU_NETWORK.displayName.toUpperCase()} TESTNET</span>
        <span className="pc-sr-desc">Experimental network</span>
      </div>
      <div className="pc-sr-item pc-anim-mask" style={{ animationDelay: "170ms" }}>
        <span className="pc-sr-title">ENCRYPTED ON THIS DEVICE</span>
        <span className="pc-sr-desc">Wallet material is stored encrypted in this browser</span>
      </div>
      <div className="pc-sr-item pc-anim-mask" style={{ animationDelay: "240ms" }}>
        <span className="pc-sr-title">NO MONETARY VALUE</span>
        <span className="pc-sr-desc">Test assets have no financial value</span>
      </div>
      <div className="pc-sr-item pc-anim-mask" style={{ animationDelay: "310ms" }}>
        <span className="pc-sr-title">NETWORK MAY RESET</span>
        <span className="pc-sr-desc">{THRU_NETWORK.displayName} state may change or reset</span>
      </div>
    </div>
  );
}
