// OFFLINE integration fixture. Never imported by production. No usable key exists.
import React, { useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import CommandDashboard from "../../components/command/CommandDashboard";
import PortWalletPopover from "../../components/port/PortWalletPopover";
import TokenStudio from "../../components/TokenStudio";
import NativeTransferProvider from "../../components/command/NativeTransferProvider";
import { useTokenPortfolio } from "../../lib/token/portfolio-hook";
import { saveKnownTokens } from "../../lib/token/portfolio";
import { PENDING_TOKEN_OPERATION_STORAGE_KEY, loadPendingTokenOperations } from "../../lib/token/pending-operation";
import { NATIVE_SEND_ENABLED } from "../../lib/wallet/native-transfer-controller";
import { createTokenSendTransport, type TokenSendTransport, type TokenSendTransportConfig,
  type TokenSendTransportStage } from "./phase5c-token-transport";

type Surface = "dashboard" | "popover" | "studio";
type StorageFault = "normal" | "journal-write" | "journal-readback" | "quota" | "denied" | "fence-write" | "cleanup";
interface PublicState {
  journalCount: number; fenceCount: number; journalWrites: number; journalReads: number;
  journalReadBacks: number; fenceWrites: number; fenceReads: number; refreshCalls: number;
  journalMalformed: boolean; containsSensitiveFields: boolean; nativeGate: boolean;
  journalSignatures: string[]; ready: boolean; wallet: "a" | "b";
}
export interface Phase5CSendQA {
  ids: TokenSendTransport["ids"];
  surface(value: Surface): void;
  wallet(value: "a" | "b"): void;
  configure(value: Partial<TokenSendTransportConfig>): void;
  stats(): ReturnType<TokenSendTransport["stats"]>;
  snapshot(): ReturnType<TokenSendTransport["snapshot"]>;
  storageFault(value: StorageFault): void;
  publicState(): PublicState;
  corruptJournal(): void;
  refresh(): void;
  unmount(): void;
  mount(): void;
  hold(stage: TokenSendTransportStage): void;
  release(stage: TokenSendTransportStage): void;
  evidence(signature: string, outcome: "success" | "failure"): void;
  prepareRecoveryEvidence(): number;
}
declare global { interface Window {
  phase5cTransport: TokenSendTransport;
  phase5cSend: Phase5CSendQA;
} }

const transport = createTokenSendTransport();
window.phase5cTransport = transport;
let surface: Surface = "dashboard", wallet: "a" | "b" = "a";
let root: Root | null = null, rerender = () => {}, refresh = () => {};
let fault: StorageFault = "normal", ready = false, refreshCalls = 0;
let journalWrites = 0, journalReads = 0, journalReadBacks = 0, fenceWrites = 0, fenceReads = 0;
let journalWrittenSinceRead = false;
const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
const journalKey = PENDING_TOKEN_OPERATION_STORAGE_KEY;
Storage.prototype.getItem = function (key: string) {
  if (key === journalKey) {
    journalReads++;
    if (journalWrittenSinceRead) { journalReadBacks++; journalWrittenSinceRead = false; }
  }
  if (key.startsWith("thru.writeFence")) fenceReads++;
  if (fault === "denied" && (key === journalKey || key.startsWith("thru.writeFence"))) {
    throw new DOMException("Synthetic storage denied", "SecurityError");
  }
  return originalGet.call(this, key);
};
Storage.prototype.setItem = function (key: string, value: string) {
  if (key === journalKey) {
    journalWrites++; journalWrittenSinceRead = true;
    if (["journal-write", "quota", "denied"].includes(fault)) {
      throw new DOMException("Synthetic journal persistence failure", fault === "denied" ? "SecurityError" : "QuotaExceededError");
    }
    // A silent lost write is an injected storage fault, NOT an application fix.
    if (fault === "journal-readback") return;
    if (fault === "cleanup" && value === "[]") throw new DOMException("Synthetic cleanup failure", "QuotaExceededError");
  }
  if (key.startsWith("thru.writeFence")) {
    fenceWrites++;
    if (fault === "fence-write") throw new DOMException("Synthetic fence failure", "QuotaExceededError");
    if (fault === "cleanup" && value === "null") throw new DOMException("Synthetic fence cleanup failure", "QuotaExceededError");
  }
  return originalSet.call(this, key, value);
};

function Harness() {
  const [, update] = useState(0);
  rerender = () => update((n) => n + 1);
  const account = wallet === "a" ? transport.accountA : transport.accountB;
  const owner = useTokenPortfolio(account, { networkStatus: "Online" });
  const refreshOwnerRecords = owner.refreshRecords;
  const refreshRecords = useCallback((...args: Parameters<typeof refreshOwnerRecords>) => {
    refreshCalls++;
    return refreshOwnerRecords(...args);
  }, [refreshOwnerRecords]);
  const shared = { ...owner, refreshRecords };
  refresh = () => { void owner.refreshRecords(owner.records); };
  ready = owner.storageReady && !owner.refreshing && owner.portfolio.some((item) => item.mintAddress === transport.ids.mint);
  const health = { status: "Online" as const, lastChecked: null, checkNow: () => {} };
  const denied = () => { throw new Error("Phase 5C forbids wallet lifecycle actions"); };
  return <NativeTransferProvider account={account} balance={10000n} networkStatus="Online" onSuccess={denied}>
    <div id="phase5c-observation" data-ready={ready} data-wallet={wallet} />
    <div data-phase5c-surface={surface} style={{ position: "relative", minHeight: 900 }}>
      {surface === "dashboard" ? <CommandDashboard account={account} balance={10000n} balanceError={null}
        walletBusy={false} walletError={null} onCreateWallet={denied} onImportWallet={async () => denied()}
        onImportBackup={async () => denied()} onForgetAccount={denied} health={health}
        onRequestFaucet={denied} portfolioHook={shared} restoreStatus="WALLET_READY" />
        : surface === "popover" ? <PortWalletPopover id="phase5c-wallet-popover" account={account}
          balance={10000n} health={health} portfolioHook={shared} onForgetAccount={denied} align="left" />
          : <TokenStudio account={account} portfolioHook={shared} health={health} />}
    </div>
  </NativeTransferProvider>;
}

function mount() {
  if (root) return;
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing isolated fixture root");
  root = createRoot(element); root.render(<Harness />);
}
function unmount() { root?.unmount(); root = null; ready = false; }
function publicState(): PublicState {
  const encoded = originalGet.call(localStorage, journalKey);
  let records: unknown = [], journalMalformed = false;
  try { records = encoded ? JSON.parse(encoded) : []; if (!Array.isArray(records)) journalMalformed = true; }
  catch { journalMalformed = true; }
  const journalSignatures = Array.isArray(records) ? records.flatMap((record: unknown) => {
    if (record && typeof record === "object" && typeof Reflect.get(record, "signature") === "string") return [String(Reflect.get(record, "signature"))];
    return [];
  }) : [];
  const fenceCount = Object.keys(localStorage).filter((key) => key.startsWith("thru.writeFence") &&
    ![null, "null"].includes(originalGet.call(localStorage, key))).length;
  return { journalCount: Array.isArray(records) ? records.length : -1, fenceCount,
    journalWrites, journalReads, journalReadBacks, fenceWrites, fenceReads, refreshCalls,
    journalMalformed, containsSensitiveFields: !!encoded && /privateKey|mnemonic|password|signedWire|transactionBytes/.test(encoded),
    nativeGate: NATIVE_SEND_ENABLED, journalSignatures, ready, wallet };
}

// Catalog contains only public identifiers; the real hook performs all live verification.
if (!originalGet.call(localStorage, "phase5c-catalog-initialized")) {
  saveKnownTokens(localStorage, [{ walletAddress: transport.ids.walletA, mintAddress: transport.ids.mint,
    tokenAccountAddresses: [transport.ids.sourceA, transport.ids.sourceB], label: "Offline token fixture" }]);
  originalSet.call(localStorage, "phase5c-catalog-initialized", "true");
}
window.phase5cSend = {
  ids: transport.ids, surface(value) { surface = value; rerender(); },
  wallet(value) { wallet = value; rerender(); }, configure: transport.configure,
  stats: transport.stats, snapshot: transport.snapshot, storageFault(value) { fault = value; },
  publicState, corruptJournal() { originalSet.call(localStorage, journalKey, "{malformed-fixture"); },
  refresh() { refresh(); }, unmount, mount, hold: transport.hold, release: transport.release,
  evidence: transport.evidence,
  prepareRecoveryEvidence() {
    // Explicit fake remote-state response, not a production reconciliation shortcut.
    // Actual UI/hook/core still has to verify it through the normal read-only path.
    const records = loadPendingTokenOperations(localStorage);
    for (const record of records) {
      transport.evidence(record.signature, "success");
      const state = record.expectedPostState;
      transport.configure({ mode: "success", destinationExists: true,
        ...(state.destinationBalance === undefined ? {} : { destinationRaw: state.destinationBalance }),
        ...(state.sourceBalance === undefined ? {} : record.sourceTokenAccount === transport.ids.sourceB
          ? { sourceBRaw: state.sourceBalance } : { sourceRaw: state.sourceBalance }) });
    }
    return records.length;
  },
};
mount();
