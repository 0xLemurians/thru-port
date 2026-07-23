"use client";

import { useState } from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import AccountPanel from "./AccountPanel";
import EditorPanel from "./EditorPanel";

export default function AppFlow() {
  const [stage, setStage] = useState<"account" | "editor">("account");
  const [account, setAccount] = useState<ThruAccount | null>(null);

  function forgetAccount() {
    account?.privateKey.fill(0);
    setAccount(null);
    setStage("account");
  }

  if (stage === "editor" && account) {
    return (
      <EditorPanel
        accountAddress={account.address}
        onBack={() => setStage("account")}
        onForgetAccount={forgetAccount}
      />
    );
  }

  return (
    <AccountPanel
      account={account}
      onAccountChange={setAccount}
      onContinue={() => setStage("editor")}
      onForgetAccount={forgetAccount}
    />
  );
}
