"use client";

import React, { useState } from "react";
import CommandShell from "@/components/command/CommandShell";
import CommandDashboard from "@/components/command/CommandDashboard";
import type { WorkspaceStage } from "@/components/port/PortHeader";
import type { TokenPortfolioHook } from "@/lib/token/portfolio-hook";

export default function DesignPreviewPage() {
  const [stage, setStage] = useState<WorkspaceStage>("account");

  const mockAccount = {
    address: "THRU_MOCK_1234567890abcdef",
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(64),
  };

  const mockPortfolioHook: TokenPortfolioHook = {
    records: [],
    portfolio: [
      {
        mintAddress: "MOCK_TOKEN_A",
        walletAddress: mockAccount.address,
        label: "Mock Token A",
        mint: {
          creator: mockAccount.address,
          mintAuthority: mockAccount.address,
          ticker: "MTKA",
          decimals: 6,
          supply: 1000000000n,
          freezeAuthority: mockAccount.address,
          hasFreezeAuthority: true,
        },
        tokenAccounts: [
          {
            address: "MOCK_TOKEN_ACCOUNT_A",
            state: {
              mint: "MOCK_TOKEN_A",
              owner: mockAccount.address,
              amount: 500000000n,
              isFrozen: false,
            },
          },
        ],
      },
      {
        mintAddress: "MOCK_TOKEN_B",
        walletAddress: mockAccount.address,
        label: "Mock Token B",
        mint: {
          creator: mockAccount.address,
          mintAuthority: mockAccount.address,
          ticker: "MTKB",
          decimals: 2,
          supply: 500000n,
          freezeAuthority: mockAccount.address,
          hasFreezeAuthority: true,
        },
        tokenAccounts: [
          {
            address: "MOCK_TOKEN_ACCOUNT_B",
            state: {
              mint: "MOCK_TOKEN_B",
              owner: mockAccount.address,
              amount: 250000n,
              isFrozen: false,
            },
          },
        ],
      },
    ],
    storageReady: true,
    refreshing: false,
    portfolioError: null,
    persistenceWarning: null,
    refreshRecords: async () => {},
    persistAndRefresh: () => {},
    addKnownToken: () => {},
    removeKnownToken: () => {},
    clearExternalAssets: () => {},
  };

  return (
    <>
      <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "var(--brand-primary)", color: "#fff", padding: "4px 12px", borderRadius: "12px", fontSize: "12px", fontWeight: "bold" }}>
        Design preview — mock data
      </div>
      <CommandShell
        currentStage={stage}
        accountAvailable={true}
        publicAddress={mockAccount.address}
        account={mockAccount}
        balance={123456789n}
        onStageChange={setStage}
        health={{ status: "Online", lastChecked: Date.now().toString(), checkNow: async () => {} }}
        onForgetAccount={async () => {}}
      >
        {stage === "account" && (
          <CommandDashboard
            account={mockAccount}
            balance={123456789n}
            balanceError={null}
            walletBusy={false}
            walletError={null}
            health={{ status: "Online", lastChecked: Date.now().toString(), checkNow: async () => {} }}
            faucetState="idle"
            faucetError={null}
            retryInfo={null}
            lastSignature={null}
            onCreateWallet={async () => false}
            onImportWallet={async () => false}
            onImportBackup={async () => false}
            onRequestFaucet={async () => {}}
            onCancelFaucet={() => {}}
            onForgetAccount={async () => {}}
            restoreStatus="WALLET_READY"
            persistenceWarning={null}
            portfolioHook={mockPortfolioHook}
          />
        )}
        {stage !== "account" && (
          <div style={{ padding: "4rem", textAlign: "center" }}>
            <h2 style={{ color: "var(--text-main)" }}>Mock View</h2>
            <p style={{ color: "var(--text-muted)" }}>This is a design preview with mock data.</p>
          </div>
        )}
      </CommandShell>
    </>
  );
}
