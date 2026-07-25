"use client";

import React from "react";

export default function PortFooter() {
  return (
    <footer className="pc-footer pc-anim-bottom" style={{ animationDelay: "400ms" }}>
      <div className="pc-footer-content">
        <div className="pc-footer-left">
          PORT <span className="pc-footer-slash">{"//"}</span> Browser-native tools for Thru AlphaNet
        </div>
        <div className="pc-footer-center">
          Designed & built by 0xLemurians <span className="pc-footer-slash">{"//"}</span> Falcon Moon icon by Lorc — CC BY 3.0
        </div>
        <div className="pc-footer-right">
          <a href="https://docs.thru.org" target="_blank" rel="noopener noreferrer" aria-label="Documentation">Documentation ↗</a>
          <a href="https://scan.thru.org" target="_blank" rel="noopener noreferrer" aria-label="Explorer">Explorer ↗</a>
        </div>
      </div>
    </footer>
  );
}
