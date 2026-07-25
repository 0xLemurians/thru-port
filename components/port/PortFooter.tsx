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
          flex-direction: row;
          align-items: center;
          justify-content: center;
          flex-wrap: nowrap;
          white-space: nowrap;
          gap: 4px;
        }
        @media (min-width: 901px) {
          .pc-footer-content {
            flex-wrap: nowrap !important;
            white-space: nowrap !important;
            align-items: center !important;
            max-width: 1200px !important;
            font-size: 12px !important;
            gap: 12px !important;
          }
          .pc-footer-left,
          .pc-footer-center,
          .pc-footer-right {
            white-space: nowrap !important;
            flex-shrink: 0;
          }
          .pc-footer-right {
            gap: 16px !important;
          }
        }
        @media (max-width: 900px) {
          .pc-footer-center {
            flex-wrap: wrap;
            white-space: normal;
          }
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
