"use client";

import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkHealth } from "./port/useNetworkHealth";
import { THRU_NETWORK } from "@/lib/thru/network";

interface NameStudioProps {
  account: ThruAccount;
  health: NetworkHealth;
  walletReady: boolean;
}

export default function NameStudio(_props: NameStudioProps) {
  void _props;
  return (
    <div className="panel name-studio">
      <div className="name-studio-header">
        <div>
          <p className="eyebrow token-eyebrow">Identity · .thru names</p>
          <h2 className="panel-title">Registration unavailable on {THRU_NETWORK.displayName}</h2>
        </div>
        <span className="workspace-nav-tag">{THRU_NETWORK.displayName.toUpperCase()}</span>
      </div>

      <div
        className="name-network-message"
        role="status"
        aria-live="polite"
        style={{ marginTop: 18 }}
      >
        <p style={{ margin: 0 }}>
          Registrations are currently unavailable on {THRU_NETWORK.displayName}.
          We&apos;ll announce on X when registration becomes available.
        </p>
      </div>
    </div>
  );
}
