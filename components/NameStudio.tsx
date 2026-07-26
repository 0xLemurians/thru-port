"use client";

import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { AlphaNetHealth } from "./port/useAlphaNetHealth";

interface NameStudioProps {
  account: ThruAccount;
  health: AlphaNetHealth;
  walletReady: boolean;
}

export default function NameStudio(_props: NameStudioProps) {
  void _props;
  return (
    <div className="panel name-studio">
      <div className="name-studio-header">
        <div>
          <p className="eyebrow token-eyebrow">Identity · .thru names</p>
          <h2 className="panel-title">Registration unavailable on AlphaNet</h2>
        </div>
        <span className="workspace-nav-tag">ALPHANET</span>
      </div>

      <div
        className="name-network-message"
        role="status"
        aria-live="polite"
        style={{ marginTop: 18 }}
      >
        <p style={{ margin: 0 }}>
          .thru registrations are not currently available on AlphaNet.
          We&apos;ll announce on X when registration becomes available.
        </p>
      </div>
    </div>
  );
}
