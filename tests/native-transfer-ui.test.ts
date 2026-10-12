import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsensusStatus, EOA_PROGRAM_ID, Pubkey, Signature, type Account } from "@thru/sdk";
import { NativeTransferController, NATIVE_SEND_ENABLED, nativeSendAvailable, nativeSendBusy,
  NATIVE_ASSET_LABEL, type NativeControllerDependencies } from "../lib/wallet/native-transfer-controller";
import { NativeTransferError, NATIVE_U64_MAX } from "../lib/wallet/native-transfer-validation";
import type { PendingNativeTransfer } from "../lib/wallet/pending-native-transfer";
import { explorerTransactionUrl } from "../lib/thru/network";
import type { NativeTransferResult } from "../lib/wallet/native-transfer";

// Public synthetic addresses/signature. No wallet key generation, secrets or network.
const wallet = Pubkey.from(new Uint8Array(32).fill(51)).toThruFmt();
const recipient = Pubkey.from(new Uint8Array(32).fill(52)).toThruFmt();
const otherWallet = Pubkey.from(new Uint8Array(32).fill(53)).toThruFmt();
const signature = Signature.from(new Uint8Array(64).fill(54)).toThruFmt();
const record: PendingNativeTransfer = { version: 1, network: "betanet:2", walletAddress: wallet,
  recipientAddress: recipient, amountRaw: "10", nonce: "1", startSlot: "100", signature,
  bodyHash: "b".repeat(64), createdAt: 1, status: "uncertain" };
function eoa(address: string, balance: bigint): Account {
  return { address: Pubkey.from(address), consensusStatus: ConsensusStatus.INCLUDED,
    meta: { version: 1, dataSize: 0, seq: 1n, balance, nonce: 1n, owner: Pubkey.from(EOA_PROGRAM_ID),
      flags: { isProgram: false, isPrivileged: false, isUncompressable: false, isEphemeral: false, isDeleted: false, isNew: false, isCompressed: false } } } as Account;
}
function outcome(kind: NativeTransferResult["outcome"]): NativeTransferResult {
  return { outcome: kind, signature, explorerUrl: explorerTransactionUrl(signature) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(enabled = true, selectedWallet = wallet) {
  let pending: PendingNativeTransfer | undefined;
  let executes = 0; let reconciles = 0; let reads = 0; let successes = 0;
  const api: NativeControllerDependencies = { enabled,
    readAccount: async (address) => { reads++; return eoa(address, address === selectedWallet ? 100n : 0n); },
    chainId: async () => 2, pending: () => pending,
    execute: async () => { executes++; return outcome("success"); },
    reconcile: async () => { reconciles++; pending = undefined; return outcome("success"); },
    onSuccess: () => { successes++; },
  };
  const controller = new NativeTransferController(selectedWallet, api);
  controller.setEnvironment(100n, "Online");
  controller.setDraft("recipient", recipient); controller.setDraft("amount", "10");
  return { controller, api, setPending(value: PendingNativeTransfer | undefined) { pending = value; },
    get executes() { return executes; }, get reconciles() { return reconciles; }, get reads() { return reads; }, get successes() { return successes; } };
}
test("production native gate is off; review, MAX and direct confirm cannot invoke execution", async () => {
  assert.equal(NATIVE_SEND_ENABLED, false);
  const s = setup(NATIVE_SEND_ENABLED);
  await s.controller.prepare(); await s.controller.prepare(true); await s.controller.confirm();
  assert.equal(s.executes, 0); assert.equal(s.reads, 0);
  assert.equal(nativeSendAvailable(s.controller.getSnapshot()), false);
});
test("fresh EOA review contains exact raw units/fee/total; opening and cancelling never sign", async () => {
  const s = setup(); await s.controller.prepare();
  assert.equal(s.executes, 0);
  assert.equal(s.controller.getSnapshot().phase, "awaiting-confirmation");
  assert.deepEqual(s.controller.getSnapshot().review, { wallet, recipient, amount: "10", fee: "1", total: "11" });
  s.controller.cancelReview(); await s.controller.confirm();
  assert.equal(s.executes, 0); assert.equal(s.controller.getSnapshot().review, null);
});
test("two surfaces confirming concurrently invoke exactly one native core operation", async () => {
  const s = setup(); const result = deferred<NativeTransferResult>(); let count = 0;
  s.api.execute = async () => { count++; return result.promise; };
  const dashboardStates: string[] = []; const popoverStates: string[] = [];
  const unsubscribe = s.controller.subscribe(() => dashboardStates.push(s.controller.getSnapshot().phase));
  s.controller.subscribe(() => popoverStates.push(s.controller.getSnapshot().phase));
  await s.controller.prepare();
  const first = s.controller.confirm(); const duplicate = s.controller.confirm();
  assert.equal(count, 1); assert.equal(nativeSendBusy(s.controller.getSnapshot()), true);
  unsubscribe(); // Closing Dashboard does not cancel the shared operation.
  result.resolve(outcome("success")); await Promise.all([first, duplicate]);
  assert.equal(s.controller.getSnapshot().phase, "success");
  assert.equal(s.successes, 1); assert.equal(s.controller.getSnapshot().revision, 1);
  assert.equal(popoverStates.at(-1), "success"); assert.equal(dashboardStates.at(-1), "submitting");
});
for (const amount of ["0", "-1", "1.2", "1e2", (NATIVE_U64_MAX + 1n).toString()]) {
  test(`UI controller reuses core raw-amount validation: ${amount}`, async () => {
    const s = setup(); s.controller.setDraft("amount", amount); await s.controller.prepare();
    assert.equal(s.controller.getSnapshot().phase, "failed"); assert.equal(s.executes, 0);
    assert.match(s.controller.getSnapshot().error!, /integer/);
  });
}
for (const address of ["not-an-address", wallet]) {
  test(`UI controller rejects invalid/self recipient: ${address === wallet ? "self" : "invalid"}`, async () => {
    const s = setup(); s.controller.setDraft("recipient", address); await s.controller.prepare();
    assert.equal(s.controller.getSnapshot().phase, "failed"); assert.equal(s.executes, 0);
  });
}
test("MAX includes source fee AND destination capacity without precision loss", async () => {
  const s = setup();
  s.api.readAccount = async (address) => eoa(address, address === wallet ? NATIVE_U64_MAX : NATIVE_U64_MAX - 9n);
  s.controller.setEnvironment(NATIVE_U64_MAX, "Online"); await s.controller.prepare(true);
  assert.equal(s.controller.getSnapshot().amount, "9"); assert.equal(s.executes, 0);
  s.api.readAccount = async (address) => eoa(address, address === wallet ? 9007199254740993n : 0n);
  await s.controller.prepare(true); assert.equal(s.controller.getSnapshot().amount, "9007199254740992");
});
test("MAX ordinary balance deducts 1 fee; zero capacity is rejected", async () => {
  const s = setup(); await s.controller.prepare(true);
  assert.equal(s.controller.getSnapshot().amount, "99");
  s.api.readAccount = async (address) => eoa(address, address === wallet ? 100n : NATIVE_U64_MAX);
  await s.controller.prepare(true); assert.equal(s.controller.getSnapshot().phase, "failed");
});
test("insufficient balance cannot reach confirmation or signing", async () => {
  const s = setup(); s.controller.setDraft("amount", "100"); await s.controller.prepare();
  assert.match(s.controller.getSnapshot().error!, /fee/); assert.equal(s.executes, 0);
});
test("program recipient, wrong account identity and missing recipient are rejected safely", async () => {
  for (const kind of ["program", "wrong-address", "missing"] as const) {
    const s = setup();
    s.api.readAccount = async (address) => {
      if (address === wallet) return eoa(wallet, 100n);
      if (kind === "missing") throw new Error("[not_found] internal proxy URL");
      const account = eoa(kind === "wrong-address" ? otherWallet : recipient, 0n);
      if (kind === "program") return { ...account, meta: { ...account.meta!, flags: { ...account.meta!.flags, isProgram: true } } } as Account;
      return account;
    };
    await s.controller.prepare(); assert.equal(s.controller.getSnapshot().phase, "failed");
    assert.doesNotMatch(s.controller.getSnapshot().error!, /proxy|not_found|URL/); assert.equal(s.executes, 0);
  }
});
test("wrong live chain prevents confirmation", async () => {
  const s = setup(); s.api.chainId = async () => 1; await s.controller.prepare();
  assert.match(s.controller.getSnapshot().error!, /Betanet/); assert.equal(s.executes, 0);
});
for (const status of ["Offline", "Checking"] as const) {
  test(`${status} blocks review and invalidates an already open confirmation`, async () => {
    const s = setup(); await s.controller.prepare(); s.controller.setEnvironment(null, status);
    await s.controller.confirm(); await s.controller.prepare();
    assert.equal(s.controller.getSnapshot().review, null); assert.equal(s.executes, 0);
    assert.equal(nativeSendAvailable(s.controller.getSnapshot()), false);
  });
}
test("unknown balance blocks review, degraded permits fresh validated reads", async () => {
  const s = setup(); s.controller.setEnvironment(null, "Online"); await s.controller.prepare();
  assert.equal(s.reads, 0);
  s.controller.setEnvironment(100n, "Degraded"); await s.controller.prepare();
  assert.equal(s.controller.getSnapshot().phase, "awaiting-confirmation");
});
test("draft change cancels stale async review and clears confirmation", async () => {
  const s = setup(); const read = deferred<Account>(); s.api.readAccount = () => read.promise;
  const first = s.controller.prepare(); s.controller.setDraft("amount", "11");
  read.resolve(eoa(wallet, 100n)); await first;
  assert.equal(s.controller.getSnapshot().review, null); assert.equal(s.controller.getSnapshot().amount, "11");
  assert.equal(s.executes, 0);
});
test("wallet switch/removal during review cannot show or submit stale wallet intent", async () => {
  const s = setup(); const read = deferred<Account>(); s.api.readAccount = () => read.promise;
  const first = s.controller.prepare(); s.controller.deactivate(); read.resolve(eoa(wallet, 100n)); await first;
  await s.controller.confirm(); assert.equal(s.executes, 0); assert.equal(s.controller.getSnapshot().review, null);
  const other = setup(true, otherWallet); assert.equal(other.controller.getSnapshot().wallet, otherWallet);
  assert.equal(other.controller.getSnapshot().result, null);
});
test("uncertain outcome blocks all retry and read-only reconciliation resolves original signature", async () => {
  const s = setup(); s.api.execute = async () => { s.setPending(record); return outcome("uncertain"); };
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.controller.getSnapshot().blocked, true); assert.equal(s.controller.getSnapshot().result?.signature, signature);
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.reads, 2);
  await s.controller.reconcile(); assert.equal(s.reconciles, 1);
  assert.equal(s.controller.getSnapshot().phase, "success"); assert.equal(s.controller.getSnapshot().blocked, false);
});
test("reload loads public journal, no signing, no implicit RPC or automatic retry", async () => {
  const s = setup(false); s.setPending(record); s.controller.hydrate();
  assert.equal(s.controller.getSnapshot().phase, "uncertain"); assert.equal(s.executes, 0); assert.equal(s.reads, 0);
  assert.equal(s.controller.getSnapshot().recipient, recipient);
  await s.controller.reconcile(); assert.equal(s.reconciles, 1); assert.equal(s.executes, 0);
});
test("unmount after submit keeps original public intent; late success is scoped to original wallet", async () => {
  const s = setup(); const result = deferred<NativeTransferResult>(); let aborted = false;
  s.api.execute = async (_recipient, _amount, signal) => {
    s.setPending(record); signal.addEventListener("abort", () => { aborted = true; }); return result.promise;
  };
  await s.controller.prepare(); const send = s.controller.confirm(); s.controller.deactivate();
  assert.equal(aborted, true); assert.equal(s.controller.getSnapshot().blocked, true);
  const other = setup(true, otherWallet);
  result.resolve(outcome("success")); await send;
  assert.equal(s.controller.getSnapshot().phase, "success"); assert.equal(s.successes, 0);
  assert.equal(other.controller.getSnapshot().result, null);
});
test("definitive execution failure permits a controlled new review; raw result message is ignored", async () => {
  const s = setup(); s.api.execute = async () => ({ ...outcome("failure"), message: "internal VM grpc proxy" });
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.controller.getSnapshot().phase, "failed"); assert.equal(s.controller.getSnapshot().blocked, false);
  assert.doesNotMatch(s.controller.getSnapshot().error!, /VM|grpc|proxy/);
  await s.controller.prepare(); assert.equal(s.controller.getSnapshot().phase, "awaiting-confirmation");
});
test("denied/corrupt journal fails closed before signing and does not delete records", async () => {
  const s = setup(); s.api.pending = () => { throw new NativeTransferError("JOURNAL_UNAVAILABLE"); };
  s.controller.hydrate(); await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.executes, 0); assert.equal(s.controller.getSnapshot().blocked, true);
});
test("cross-tab journal arriving after review prevents confirm from executing", async () => {
  const s = setup(); await s.controller.prepare(); s.setPending(record); await s.controller.confirm();
  assert.equal(s.executes, 0); assert.equal(s.controller.getSnapshot().phase, "uncertain");
});
test("throw after durable intent stays uncertain, while known preflight failure is retryable", async () => {
  const s = setup(); s.api.execute = async () => { s.setPending(record); throw new Error("transport upstream"); };
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.controller.getSnapshot().phase, "uncertain"); assert.equal(s.controller.getSnapshot().result?.signature, signature);
  const before = setup(); before.api.execute = async () => { throw new NativeTransferError("INSUFFICIENT_BALANCE"); };
  await before.controller.prepare(); await before.controller.confirm();
  assert.equal(before.controller.getSnapshot().phase, "failed"); assert.equal(before.controller.getSnapshot().blocked, false);
});
test("reconciliation timeout/transient failure remains uncertain with no send and no balance proof", async () => {
  const s = setup(); s.setPending(record); s.controller.hydrate();
  s.api.reconcile = async () => { throw new Error("raw grpc timeout"); };
  await s.controller.reconcile(); assert.equal(s.controller.getSnapshot().phase, "uncertain");
  assert.equal(s.controller.getSnapshot().blocked, true); assert.equal(s.executes, 0);
  assert.doesNotMatch(s.controller.getSnapshot().error!, /grpc/);
});
test("verified success plus cleanup warning stays successful but blocks another submission", async () => {
  const s = setup(); s.api.execute = async () => ({ ...outcome("success"), persistenceWarning: true });
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.controller.getSnapshot().phase, "success"); assert.equal(s.controller.getSnapshot().blocked, true);
});

// CSS modules are Next's responsibility. Stub them ONLY in this Node render test,
// not application code; the real production React components are rendered below.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true,
      source: 'export default new Proxy({}, { get: (_target, name) => String(name) });' };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);
test("real native form renders exact raw balance, disabled production controls and accessible input labels", async () => {
  const { NativeSendFields } = await import("../components/command/NativeSendForm");
  const s = setup(false); s.controller.setEnvironment(9007199254740993n, "Online");
  const html = renderToStaticMarkup(React.createElement(NativeSendFields, { state: s.controller.getSnapshot(), controller: s.controller }));
  assert.match(html, /9007199254740993 native units/); assert.match(html, /integer raw native units/);
  assert.match(html, /type="submit"[^>]*disabled/); assert.match(html, /disabled=""[^>]*>MAX/);
  assert.match(html, /for="[^"]+-recipient"/); assert.match(html, /aria-label="Native transfer"/);
  assert.doesNotMatch(html, /privateKey|mnemonic|token account creation/);
});
test("real confirmation renders full addresses and exact debit, not secrets or shortened intent", async () => {
  const { NativeConfirmationDialog } = await import("../components/command/NativeTransferConfirmation");
  const s = setup(); await s.controller.prepare();
  const html = renderToStaticMarkup(React.createElement(NativeConfirmationDialog, { review: s.controller.getSnapshot().review!, onConfirm: s.controller.confirm, onCancel: s.controller.cancelReview }));
  assert.match(html, /<dialog[^>]*aria-labelledby/); assert.match(html, /Thru Betanet/);
  assert.ok(html.includes(wallet)); assert.ok(html.includes(recipient)); assert.match(html, /11 raw native units/);
  assert.match(html, /Confirm send/); assert.match(html, /Cancel/); assert.equal(s.executes, 0);
});
test("actual status view exposes original Betanet Explorer link and read-only refresh, never Retry", async () => {
  const { NativeTransferStatus } = await import("../components/command/NativeSendForm");
  const s = setup(); s.setPending(record); s.controller.hydrate();
  const html = renderToStaticMarkup(React.createElement(NativeTransferStatus, { state: s.controller.getSnapshot(), onReconcile: () => {} }));
  assert.ok(html.includes(explorerTransactionUrl(signature))); assert.match(html, /noopener noreferrer/);
  assert.match(html, /Refresh status \(read-only\)/); assert.doesNotMatch(html, />Retry</);
});
test("both production send surfaces expose native alongside existing token-only paths; theme uses shared variables", () => {
  for (const file of ["components/command/CommandDashboard.tsx", "components/port/PortWalletPopover.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /<SendAssetPicker/); assert.match(source, /NATIVE_ASSET_VALUE/);
    assert.match(source, /<NativeSendForm/); assert.match(source, /useTokenTransfer/);
  }
  assert.equal(NATIVE_ASSET_LABEL, "Native THRU — native units");
  const styles = readFileSync("components/command/command.module.css", "utf8");
  assert.match(styles, /\.nativeDialog[^]*?var\(--surface\)/); assert.match(styles, /\.nativeReview dd[^]*?overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 480px\) \{ \.nativeReview/);
  const provider = readFileSync("components/command/NativeTransferProvider.tsx", "utf8");
  assert.match(provider, /!NATIVE_SEND_ENABLED/); assert.match(provider, /reconcileNativeTransfer\(wallet, \{ signal \}\)/);
  assert.doesNotMatch(provider, /console\.|track\(|setItem\(/);
});

test("real shared asset picker switches native/token, rejects unknown assets, and guards disabled events", async () => {
  const { default: Picker, selectSendAsset } = await import("../components/command/SendAssetPicker");
  const selected: string[] = [];
  const props = { value: recipient, disabled: false, options: [{ value: recipient, label: "SMOKE — 1.25" }], onChange: (asset: string) => selected.push(asset) };
  selectSendAsset(props, "native-units"); selectSendAsset(props, recipient);
  selectSendAsset(props, "unknown"); selectSendAsset({ ...props, disabled: true }, "native-units");
  assert.deepEqual(selected, ["native-units", recipient]);
  const html = renderToStaticMarkup(React.createElement(Picker, props));
  assert.match(html, /Native THRU — native units/); assert.match(html, /SMOKE — 1.25/);
  assert.match(html, /<label[^>]+for=/);
});

test("real native form displays safe validation for fractional, scientific and insufficient amounts", async () => {
  const { NativeSendFields } = await import("../components/command/NativeSendForm");
  for (const amount of ["1.5", "1e3", "100"]) {
    const s = setup(); s.controller.setDraft("amount", amount);
    const html = renderToStaticMarkup(React.createElement(NativeSendFields, { state: s.controller.getSnapshot(), controller: s.controller }));
    assert.match(html, /role="alert"/); assert.match(html, /type="submit"[^>]*disabled/);
    assert.equal(s.executes, 0);
  }
});

test("actual status view never renders internal result messages and preserves uncertain retry guard", async () => {
  const { NativeTransferStatus } = await import("../components/command/NativeSendForm");
  const s = setup(); s.setPending(record); s.controller.hydrate();
  const state = { ...s.controller.getSnapshot(), result: { ...outcome("uncertain"), message: "grpc proxy transport raw-internals" } };
  const html = renderToStaticMarkup(React.createElement(NativeTransferStatus, { state, onReconcile: () => {} }));
  assert.doesNotMatch(html, /grpc|proxy|raw-internals/); assert.match(html, /Final confirmation is unavailable/);
});

test("balance/Activity refresh failure cannot downgrade verified transaction success", async () => {
  const s = setup(); s.api.onSuccess = () => { throw new Error("refresh unavailable"); };
  await s.controller.prepare(); await s.controller.confirm();
  assert.equal(s.controller.getSnapshot().phase, "success"); assert.equal(s.controller.getSnapshot().result?.signature, signature);
});

test("confirming is a real read-only recovery boundary, with duplicate refresh suppressed", async () => {
  const s = setup(); s.setPending(record); s.controller.hydrate();
  const status = deferred<NativeTransferResult>(); let queries = 0;
  s.api.reconcile = async () => { queries++; return status.promise; };
  const first = s.controller.reconcile(); const duplicate = s.controller.reconcile();
  assert.equal(s.controller.getSnapshot().phase, "confirming"); assert.equal(queries, 1);
  assert.equal(s.executes, 0);
  status.resolve(outcome("uncertain")); await Promise.all([first, duplicate]);
  assert.equal(s.controller.getSnapshot().phase, "uncertain"); assert.equal(s.controller.getSnapshot().blocked, true);
});
