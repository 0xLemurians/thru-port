"use client";

import React from "react";

export default function PortMark() {
  return (
    <svg className="pc-port-mark" width="18" height="18" viewBox="0 0 24 24">
      <path className="pc-port-mark-path" d="M12 4 A 8 8 0 1 1 4 12" fill="none" stroke="#F47A3C" strokeWidth="2.5" strokeLinecap="round" />
      <circle className="pc-port-mark-node" cx="12" cy="4" r="2.5" fill="#D8A15D" />
      <circle className="pc-port-mark-node" cx="20" cy="12" r="2.5" fill="#D8A15D" />
      <circle className="pc-port-mark-node" cx="4" cy="12" r="2.5" fill="#D8A15D" />
    </svg>
  );
}
