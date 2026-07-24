"use client";

import { useState } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import AccountPanel from "./AccountPanel";
import EditorPanel from "./EditorPanel";
import NameStudio from "./NameStudio";
import TokenStudio from "./TokenStudio";
import WorkspaceNav, { type WorkspaceStage } from "./WorkspaceNav";

export default function AppFlow() {
  const [stage, setStage] = useState<WorkspaceStage>("account");
  const [account, setAccount] = useState<ThruAccount | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  function forgetAccount() {
    account?.privateKey.fill(0);
    setTokenBusy(false);
    setAccount(null);
    setStage("account");
  }

  if (stage === "editor" && account) {
    return (
      <>
        <WorkspaceNav
          current={stage}
          onChange={setStage}
          disabled={tokenBusy}
          accountAvailable
        />
        <EditorPanel
          accountAddress={account.address}
          onBack={() => setStage("account")}
          onForgetAccount={forgetAccount}
        />
      </>
    );
  }

  if (stage === "token") {
    return (
      <>
        <WorkspaceNav
          current={stage}
          onChange={setStage}
          disabled={tokenBusy}
          accountAvailable={Boolean(account)}
        />
        <TokenStudio account={account} onBusyChange={setTokenBusy} />
      </>
    );
  }

  if (stage === "name") {
    return (
      <>
        <WorkspaceNav
          current={stage}
          onChange={setStage}
          disabled={tokenBusy}
          accountAvailable={Boolean(account)}
        />
        <NameStudio />
      </>
    );
  }

  return (
    <>
      <WorkspaceNav
        current={stage}
        onChange={setStage}
        disabled={tokenBusy}
        accountAvailable={Boolean(account)}
      />
      <AccountPanel
        account={account}
        onAccountChange={setAccount}
        onContinue={() => setStage("editor")}
        onForgetAccount={forgetAccount}
      />
    </>
  );
}
