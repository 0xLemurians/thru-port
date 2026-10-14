import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PortFaucetPanel from "../components/port/PortFaucetPanel";
import { SAFE_FAUCET_UNCERTAIN_MESSAGE, SAFE_FAUCET_UNAVAILABLE_MESSAGE } from "../lib/wallet/faucet-safety";
import type { NetworkStatus } from "../lib/network/network-health";
import type { WorkspaceStage } from "../components/port/PortHeader";

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true,
      source: 'export default new Proxy({}, { get: (_target, name) => String(name) });' };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);

interface UiProps {
  children?: React.ReactNode;
  id?: string;
  type?: string;
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  "aria-describedby"?: string;
}
function elements(node: React.ReactNode): React.ReactElement<UiProps>[] {
  const result: React.ReactElement<UiProps>[] = [];
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<UiProps>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}
function text(node: React.ReactNode): string {
  let value = "";
  React.Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") value += child;
    else if (React.isValidElement<UiProps>(child)) value += text(child.props.children);
  });
  return value;
}
function button(tree: React.ReactNode, label: string) {
  const result = elements(tree).find((item) => item.type === "button" && text(item.props.children).includes(label));
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
type FaucetProps = React.ComponentProps<typeof PortFaucetPanel>;
function faucet(t: TestContext, overrides: Partial<FaucetProps> = {}) {
  t.mock.method(React, "useId", () => "wallet-notice-test");
  let requests = 0, cancels = 0;
  const tree = PortFaucetPanel({ accountAvailable: false, faucetState: "idle", faucetError: null,
    retryInfo: null, lastSignature: null, health: { status: "Online", lastChecked: null, checkNow: () => {} },
    onRequest: () => requests++, onCancel: () => cancels++, ...overrides });
  return { tree, requests: () => requests, cancels: () => cancels };
}

for (const status of ["Online", "Degraded", "Offline", "Checking"] satisfies NetworkStatus[]) {
  test(`actual Faucet request and Retry are disabled without a wallet: ${status}`, (t) => {
    const view = faucet(t, { faucetState: "error", faucetError: "Safe test failure",
      health: { status, lastChecked: null, checkNow: () => {} } });
    for (const label of ["Get 10000", "Retry"]) {
      const action = button(view.tree, label);
      assert.equal(action.props.disabled, true);
      action.props.onClick?.(); // Even direct/programmatic callback invocation stays guarded.
    }
    assert.equal(view.requests(), 0);
    const html = renderToStaticMarkup(view.tree);
    assert.match(html, /Connect or create a wallet to request test units\./);
    assert.match(html, /id="wallet-notice-test"[^>]*role="status"/);
    assert.equal(button(view.tree, "Get 10000").props["aria-describedby"], "wallet-notice-test");
    assert.equal(button(view.tree, "Retry").props["aria-describedby"], "wallet-notice-test");
    assert.match(html, /color:var\(--text-muted\)/);
    assert.match(html, /opacity:1/);
    assert.match(html, /cursor:not-allowed/);
  });
}
test("wallet available and Online preserves explicit Faucet and Retry callbacks", (t) => {
  const view = faucet(t, { accountAvailable: true, faucetState: "error", faucetError: "Safe test failure" });
  for (const label of ["Get 10000", "Retry"]) {
    const action = button(view.tree, label);
    assert.equal(action.props.disabled, false); action.props.onClick?.();
  }
  assert.equal(view.requests(), 2);
  assert.doesNotMatch(renderToStaticMarkup(view.tree), /Connect or create a wallet/);
});
for (const status of ["Degraded", "Offline", "Checking"] satisfies NetworkStatus[]) {
  test(`wallet availability does not bypass existing RPC restriction: ${status}`, (t) => {
    const view = faucet(t, { accountAvailable: true, health: { status, lastChecked: null, checkNow: () => {} } });
    const action = button(view.tree, "Get 10000");
    assert.equal(action.props.disabled, true); action.props.onClick?.(); assert.equal(view.requests(), 0);
  });
}
test("an in-flight request stays blocked but Cancel remains available after wallet removal", (t) => {
  const view = faucet(t, { faucetState: "requesting" });
  const request = button(view.tree, "Requesting tokens");
  assert.equal(request.props.disabled, true); request.props.onClick?.();
  const cancel = button(view.tree, "Cancel request");
  assert.notEqual(cancel.props.disabled, true); cancel.props.onClick?.();
  assert.equal(view.requests(), 0); assert.equal(view.cancels(), 1);
});
test("a connected wallet cannot start a competing in-flight Faucet request", (t) => {
  const view = faucet(t, { accountAvailable: true, faucetState: "requesting" });
  const request = button(view.tree, "Requesting tokens");
  assert.equal(request.props.disabled, true); request.props.onClick?.();
  assert.equal(view.requests(), 0);
  assert.notEqual(button(view.tree, "Cancel request").props.disabled, true);
});
for (const error of [SAFE_FAUCET_UNCERTAIN_MESSAGE, SAFE_FAUCET_UNAVAILABLE_MESSAGE]) {
  test(`existing manual-verification rule still blocks a connected wallet: ${error}`, (t) => {
    const view = faucet(t, { accountAvailable: true, faucetState: "error", faucetError: error });
    for (const label of ["Get 10000", "Retry"]) {
      const action = button(view.tree, label); assert.equal(action.props.disabled, true); action.props.onClick?.();
    }
    assert.equal(view.requests(), 0);
  });
}

// Only React hooks are mocked here: production JSX, callbacks and DOM event
// listener cleanup are exercised directly. Real React/keyboard behavior is also
// checked in the isolated local browser, without adding a test dependency.
async function shell(t: TestContext, accountAvailable = true) {
  const { default: Shell } = await import("../components/command/CommandShell");
  const values: unknown[] = [true, "dark", false];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0, refIndex = 0;
  let effects: React.EffectCallback[] = [];
  const stages: WorkspaceStage[] = [];
  t.mock.method(React, "useId", () => "navigation-test");
  t.mock.method(React, "useState", function <S>(initial?: S | (() => S)) {
    const index = stateIndex++;
    if (!(index in values)) values[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    const set: React.Dispatch<React.SetStateAction<S>> = (next) => {
      values[index] = typeof next === "function" ? (next as (previous: S) => S)(values[index] as S) : next;
    };
    return [values[index] as S, set] as [S, React.Dispatch<React.SetStateAction<S>>];
  });
  t.mock.method(React, "useRef", function <T>(initial: T) {
    const index = refIndex++; refs[index] ??= { current: initial };
    return refs[index] as React.RefObject<T>;
  });
  t.mock.method(React, "useEffect", (effect: React.EffectCallback) => { effects.push(effect); });
  const render = () => {
    stateIndex = 0; refIndex = 0; effects = [];
    return Shell({ currentStage: "account", accountAvailable, onStageChange: (stage) => stages.push(stage),
      health: { status: "Online", lastChecked: null, checkNow: () => {} }, children: "Public test workspace" });
  };
  const toggle = (tree: React.ReactNode) => {
    const found = elements(tree).find((item) => item.props["aria-controls"] === "navigation-test");
    assert.ok(found); return found;
  };
  return { render, toggle, stages, refs, effects: () => effects };
}
test("actual hamburger is a named native button whose expanded state controls the existing nav", async (t) => {
  const view = await shell(t); let tree = view.render(); let toggle = view.toggle(tree);
  assert.equal(toggle.type, "button"); assert.equal(toggle.props.type, "button");
  assert.equal(toggle.props["aria-label"], "Open navigation menu");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.ok(elements(tree).some((item) => item.type === "nav" && item.props.id === toggle.props["aria-controls"]));
  toggle.props.onClick?.(); tree = view.render(); toggle = view.toggle(tree);
  assert.equal(toggle.props["aria-expanded"], true); assert.equal(toggle.props["aria-label"], "Close navigation menu");
  toggle.props.onClick?.(); assert.equal(view.toggle(view.render()).props["aria-expanded"], false);
});
test("existing desktop/stage navigation remains available and closes the mobile menu", async (t) => {
  const view = await shell(t);
  for (const [label, stage] of [["Dashboard", "account"], ["Tokens", "token"], ["Identity", "name"]] as const) {
    view.toggle(view.render()).props.onClick?.(); const tree = view.render();
    const action = button(tree, label); assert.equal(action.props.disabled ?? false, false);
    action.props.onClick?.(); assert.equal(view.stages.at(-1), stage);
    assert.equal(view.toggle(view.render()).props["aria-expanded"], false);
  }
});

function documentTarget(t: TestContext) {
  const target = new EventTarget(); let activeElement: unknown = null;
  Object.defineProperty(target, "activeElement", { get: () => activeElement });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: target });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
  return { target, focus: (element: unknown) => { activeElement = element; }, focused: () => activeElement };
}
function key(target: EventTarget, value: string, prevented = false) {
  const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value });
  if (prevented) event.preventDefault(); target.dispatchEvent(event);
}
test("Escape closes actual menu state, restores appropriate focus, and cleanup removes its listener", async (t) => {
  const view = await shell(t), doc = documentTarget(t); let focusCalls = 0;
  const link = {}, trigger = { getClientRects: () => [{}], focus: () => { focusCalls++; doc.focus(trigger); } };
  view.render(); view.refs[0].current = trigger; view.refs[1].current = { contains: (node: unknown) => node === link };
  view.toggle(view.render()).props.onClick?.(); view.render();
  const cleanup = view.effects()[1](); assert.equal(typeof cleanup, "function"); doc.focus(link);
  key(doc.target, "Enter"); assert.equal(view.toggle(view.render()).props["aria-expanded"], true);
  key(doc.target, "Escape", true); assert.equal(focusCalls, 0);
  key(doc.target, "Escape"); assert.equal(view.toggle(view.render()).props["aria-expanded"], false);
  assert.equal(focusCalls, 1); assert.equal(doc.focused(), trigger);
  if (typeof cleanup === "function") cleanup();
  key(doc.target, "Escape"); assert.equal(focusCalls, 1);
  assert.equal(view.effects()[1](), undefined); // Closed menu installs no replacement listener.
});
test("Escape never steals unrelated focus and never focuses a hidden desktop hamburger", async (t) => {
  const view = await shell(t), doc = documentTarget(t); let focusCalls = 0;
  const outside = {}, trigger = { getClientRects: () => [], focus: () => { focusCalls++; } };
  view.render(); view.refs[0].current = trigger; view.refs[1].current = { contains: () => false };
  view.toggle(view.render()).props.onClick?.(); view.render(); const cleanup = view.effects()[1]();
  doc.focus(outside); key(doc.target, "Escape"); assert.equal(doc.focused(), outside); assert.equal(focusCalls, 0);
  view.toggle(view.render()).props.onClick?.(); view.render(); doc.focus(trigger);
  key(doc.target, "Escape"); assert.equal(focusCalls, 0);
  if (typeof cleanup === "function") cleanup();
});
test("unmount cleanup prevents a late Escape from changing the old component", async (t) => {
  const view = await shell(t), doc = documentTarget(t);
  view.toggle(view.render()).props.onClick?.(); view.render(); const cleanup = view.effects()[1]();
  if (typeof cleanup === "function") cleanup();
  key(doc.target, "Escape"); assert.equal(view.toggle(view.render()).props["aria-expanded"], true);
});
