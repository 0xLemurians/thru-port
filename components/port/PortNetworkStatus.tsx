import React from "react";
import type { NetworkStatus } from "./useAlphaNetHealth";

interface PortNetworkStatusProps {
  status: NetworkStatus;
}

export default function PortNetworkStatus({ status }: PortNetworkStatusProps) {
  const getStatusColor = () => {
    switch (status) {
      case "Online":
        return "#10b981"; // Emerald green
      case "Checking":
      case "Degraded":
        return "#f59e0b"; // Amber
      case "Offline":
        return "#ef4444"; // Red
      default:
        return "#f59e0b";
    }
  };

  return (
    <div
      className="pc-network-badge"
      title="RPC reachability status — not a guarantee of full network health."
      style={{ display: "flex", alignItems: "center", gap: "6px" }}
    >
      <span>ALPHANET</span>
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          backgroundColor: getStatusColor(),
          display: "inline-block",
        }}
      />
      <span style={{ color: getStatusColor(), fontWeight: 600 }}>
        {status.toUpperCase()}
      </span>
    </div>
  );
}
