"use client";

import React from "react";

export default function PortFooter() {
  return (
    <footer className="pc-footer pc-anim-bottom" style={{ animationDelay: "400ms" }}>
      <style>{`
        .pc-footer-creator-link {
          color: var(--ember-soft);
          text-decoration: none;
          text-transform: none;
          transition: color 0.15s ease;
        }
        .pc-footer-creator-link:hover {
          color: var(--parchment);
        }
        .pc-footer-center {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 4px;
        }
      `}</style>
      <div className="pc-footer-content">
        <div className="pc-footer-left">
          PORT <span className="pc-footer-slash">{"//"}</span> Browser-native tools for Thru AlphaNet
        </div>
        <div className="pc-footer-center">
          <span>
            Built by{" "}
            <a
              href="https://x.com/S1Y4HS4NC4KS"
              target="_blank"
              rel="noopener noreferrer"
              className="pc-footer-creator-link"
              aria-label="0xLemurians on X"
            >
              0xLemurians
            </a>
          </span>
          <span className="pc-footer-slash">{"//"}</span>
          <span>Falcon Moon icon by Lorc — CC BY 3.0</span>
        </div>
        <div className="pc-footer-right">
          <a href="https://docs.thru.org" target="_blank" rel="noopener noreferrer" aria-label="Documentation">Documentation ↗</a>
          <a href="https://scan.thru.org" target="_blank" rel="noopener noreferrer" aria-label="Explorer">Explorer ↗</a>
        </div>
      </div>
    </footer>
  );
}
