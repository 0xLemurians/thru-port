import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire, register } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
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

// Real browser coverage is necessary here: Node hook mocks cannot reproduce
// CSS visibility interpolation or the browser's sequential keyboard focus order.
interface NavigationLocator {
  click(): Promise<void>; focus(): Promise<void>;
  getAttribute(name: string): Promise<string | null>; isVisible(): Promise<boolean>;
  evaluate<T>(fn: (element: HTMLElement) => T): Promise<Awaited<T>>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): NavigationLocator;
}
interface NavigationPage {
  keyboard: { press(key: string): Promise<void> };
  setDefaultTimeout(ms: number): void; goto(url: string): Promise<unknown>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  locator(selector: string): NavigationLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): NavigationLocator;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  waitForFunction(expression: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(options: { reducedMotion: "reduce" | "no-preference" }): Promise<void>;
  on(event: "pageerror", cb: (error: Error) => void): void;
  on(event: "console", cb: (message: { type(): string; text(): string }) => void): void;
}
interface NavigationRuntime {
  chromium: { executablePath(): string; launch(options: { headless: boolean; executablePath: string; args: string[] }): Promise<{
    close(): Promise<void>;
    newContext(options: { serviceWorkers: "block" }): Promise<{
      cookies(): Promise<unknown[]>; storageState(): Promise<{ cookies: unknown[]; origins: unknown[] }>;
      newPage(): Promise<NavigationPage>;
      route(pattern: string, cb: (route: { request(): { url(): string };
        fulfill(options: { status: number; contentType: string; body: string }): Promise<void>; abort(): Promise<void> }) => Promise<void>): Promise<void>;
    }>;
  }> };
}

test("real hydrated CommandShell excludes closed mobile navigation immediately from keyboard focus", { timeout: 120_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const bundled = path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  let runtime: NavigationRuntime;
  try { runtime = require(process.env.PLAYWRIGHT_MODULE_PATH ?? (existsSync(bundled) ? bundled : "playwright")) as NavigationRuntime; }
  catch { t.skip("Existing Playwright unavailable; no browser or dependency will be installed."); return; }
  const executablePath = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  if (!executablePath) { t.skip("No installed Chromium; this regression never downloads one."); return; }
  const { default: Shell } = await import("../components/command/CommandShell");
  const children = React.createElement("main", null,
    React.createElement("label", { htmlFor: "navigation-outside" }, "Public workspace field"),
    React.createElement("input", { id: "navigation-outside" }),
    React.createElement("button", { type: "button" }, "Public workspace action"));
  const shellProps: React.ComponentProps<typeof Shell> = { currentStage: "account", accountAvailable: false,
    onStageChange: () => {}, health: { status: "Online", lastChecked: null, checkNow: () => {} }, children };
  const ssr = renderToString(React.createElement(Shell, shellProps, children));
  const shellPath = path.resolve("components/command/CommandShell.tsx").replaceAll("\\", "/");
  const bundles = await build({ stdin: { contents: `
    import React from 'react'; import {hydrateRoot} from 'react-dom/client';
    import Shell from ${JSON.stringify(shellPath)};
    window.navigationQA={stages:[],hydrationErrors:[],unmount:()=>{}};
    const root=hydrateRoot(document.getElementById('root'),
      <Shell currentStage="account" accountAvailable={false}
        health={{status:'Online',lastChecked:null,checkNow:()=>{}}}
        onStageChange={stage=>window.navigationQA.stages.push(stage)}>
        <main><label htmlFor="navigation-outside">Public workspace field</label>
          <input id="navigation-outside"/><button type="button">Public workspace action</button></main>
      </Shell>,{onRecoverableError:error=>window.navigationQA.hydrationErrors.push(error.message)});
    window.navigationQA.unmount=()=>root.unmount();
  `, loader: "jsx", resolveDir: process.cwd(), sourcefile: "navigation-browser-entry.jsx" },
    bundle: true, write: false, outdir: "unused-navigation-output", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' } });
  const browser = await runtime.chromium.launch({ headless: true, executablePath,
    args: ["--disable-extensions", "--disable-sync", "--no-first-run"] });
  try {
    // launch() owns a new temporary profile; no persistent/default user profile is used.
    const context = await browser.newContext({ serviceWorkers: "block" });
    assert.deepEqual(await context.storageState(), { cookies: [], origins: [] });
    const unexpectedRequests: string[] = [], problems: string[] = [];
    await context.route("**/*", async route => {
      if (route.request().url() === "http://navigation.test/") await route.fulfill({ status: 200, contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root">${ssr}</div><button id="after-shell" type="button">After shell</button></body></html>` });
      else { unexpectedRequests.push(new URL(route.request().url()).hostname); await route.abort(); }
    });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.setViewportSize({ width: 390, height: 900 });
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) problems.push(message.text()); });
    await page.goto("http://navigation.test/");
    assert.deepEqual(await page.evaluate(async () => ({ origin: location.origin, local: localStorage.length,
      session: sessionStorage.length, databases: (await indexedDB.databases()).length })),
      { origin: "http://navigation.test", local: 0, session: 0, databases: 0 });
    await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
    for (const output of bundles.outputFiles) {
      if (output.path.endsWith(".css")) await page.addStyleTag({ content: output.text });
      else if (output.path.endsWith(".js")) await page.addScriptTag({ content: output.text });
    }
    await page.getByRole("button", { name: "Open navigation menu", exact: true }).getAttribute("aria-controls");
    const nav = page.locator('nav[aria-label="Main navigation"]');
    const trigger = page.getByRole("button", { name: /navigation menu$/ });
    const dashboard = nav.getByRole("button", { name: /Dashboard$/ });
    const outside = page.locator("#navigation-outside");
    const state = () => page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Main navigation"]')!;
      const trigger = document.querySelector('[aria-controls][aria-expanded]')!;
      return { expanded: trigger.getAttribute("aria-expanded"), visibility: getComputedStyle(nav).visibility,
        inNav: nav.contains(document.activeElement), onTrigger: document.activeElement === trigger,
        activeId: document.activeElement?.id, lostFocus: document.activeElement === document.body,
        controlsHidden: [...nav.querySelectorAll("button,a")].every(control => getComputedStyle(control).visibility === "hidden") };
    });
    const open = async (key: "Enter" | "Space" = "Enter") => {
      if (await trigger.getAttribute("aria-expanded") !== "true") { await trigger.focus(); await page.keyboard.press(key); }
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      // Wait only for OPENING. The Escape -> Tab race below contains no delay.
      await page.waitForFunction(`getComputedStyle(document.querySelector('nav[aria-label="Main navigation"]')).visibility === 'visible' &&
        new DOMMatrixReadOnly(getComputedStyle(document.querySelector('nav[aria-label="Main navigation"]')).transform).m41 === 0`);
    };
    const setTheme = async (theme: "dark" | "light", mobile: boolean) => {
      if (await page.evaluate(() => document.documentElement.getAttribute("data-theme")) === theme) return;
      if (mobile) await open();
      await page.getByRole("button", { name: `Switch to ${theme} mode`, exact: true }).click();
      if (mobile) await page.keyboard.press("Escape");
    };
    let immediateSequences = 0;
    const immediateEscapeTab = async () => {
      await dashboard.focus();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab"); // No sleep, animation wait or intermediate DOM assertion.
      const result = await state();
      assert.equal(result.expanded, "false");
      assert.equal(result.inNav, false, `Immediate Tab must never enter closed navigation: ${JSON.stringify(result)}`);
      assert.equal(result.visibility, "hidden");
      assert.equal(result.controlsHidden, true);
      assert.equal(result.lostFocus, false); assert.equal(result.activeId, "navigation-outside");
      immediateSequences++;
    };
    await t.test("actual server output hydrates with a clean isolated origin and no errors", async () => {
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(await nav.getAttribute("id"), await trigger.getAttribute("aria-controls"));
      assert.deepEqual(await page.evaluate(() => window.navigationQA.hydrationErrors), []);
      assert.deepEqual(problems, []);
    });
    for (const width of [320, 390, 768]) for (const theme of ["dark", "light"] as const) {
      await t.test(`${width}px ${theme}: immediate Escape/Tab and every closing sample exclude navigation`, async () => {
        await page.setViewportSize({ width, height: 900 }); await setTheme(theme, true);
        for (let cycle = 0; cycle < 3; cycle++) { await open(cycle % 2 ? "Space" : "Enter"); await immediateEscapeTab(); }
        await open(); await dashboard.focus(); await page.keyboard.press("Escape");
        const snapshots = [{ ms: 0, value: await state() }];
        for (const [delay, ms] of [[50, 50], [100, 150], [200, 350]]) {
          await page.waitForTimeout(delay); snapshots.push({ ms, value: await state() });
        }
        for (const snapshot of snapshots) {
          assert.equal(snapshot.value.expanded, "false"); assert.equal(snapshot.value.visibility, "hidden");
          assert.equal(snapshot.value.controlsHidden, true);
          assert.equal(snapshot.value.inNav, false); assert.equal(snapshot.value.onTrigger, true);
          assert.equal(snapshot.value.lostFocus, false);
        }
        assert.equal(await nav.evaluate(element => getComputedStyle(element).transitionProperty), "transform");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        t.diagnostic(`Focus samples ${width}px ${theme}: 0/50/150/350ms all on trigger, nav hidden; immediate Tab x3 goes to public field.`);
      });
    }
    await t.test("mouse trigger/selection closure and unrelated Escape focus remain correct", async () => {
      await page.setViewportSize({ width: 390, height: 900 });
      await open(); await trigger.click(); await page.keyboard.press("Tab");
      assert.equal((await state()).activeId, "navigation-outside"); assert.equal((await state()).inNav, false);
      await open("Space"); await dashboard.click(); await page.keyboard.press("Tab");
      assert.equal((await state()).expanded, "false"); assert.equal((await state()).inNav, false);
      assert.equal((await state()).lostFocus, false);
      assert.deepEqual(await page.evaluate(() => window.navigationQA.stages), ["account"]);
      await open(); await outside.focus(); await page.keyboard.press("Escape");
      assert.equal((await state()).activeId, "navigation-outside"); assert.equal((await state()).expanded, "false");
    });
    await t.test("desktop keyboard navigation and breakpoint resizing preserve access without stealing focus", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      // The unchanged desktop transition can run across a breakpoint. Settle
      // resizing only; the Escape -> immediate Tab checks above never wait.
      await page.waitForFunction(`getComputedStyle(document.querySelector('nav[aria-label="Main navigation"]')).visibility === 'visible'`);
      for (const theme of ["dark", "light"] as const) {
        await setTheme(theme, false);
        assert.equal(await nav.isVisible(), true); assert.equal(await trigger.isVisible(), false);
        assert.equal(await nav.evaluate(element => getComputedStyle(element).transitionProperty), "all");
        await dashboard.focus(); await page.keyboard.press("Tab"); assert.equal((await state()).inNav, true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await outside.focus();
      for (const width of [768, 769, 1440, 320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(`getComputedStyle(document.querySelector('nav[aria-label="Main navigation"]')).visibility === '${width <= 768 ? "hidden" : "visible"}'`);
        assert.equal((await state()).visibility, width <= 768 ? "hidden" : "visible");
        assert.equal((await state()).activeId, "navigation-outside");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      // A logical mobile-open state must not hide or trap the desktop sidebar.
      await page.setViewportSize({ width: 390, height: 900 }); await open();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(`getComputedStyle(document.querySelector('nav[aria-label="Main navigation"]')).visibility === 'visible'`);
      await dashboard.focus(); await page.keyboard.press("Escape");
      assert.equal(await nav.isVisible(), true); assert.equal(await trigger.isVisible(), false);
      assert.equal((await state()).onTrigger, false); assert.equal((await state()).inNav, true);
    });
    await t.test("reduced-motion preference preserves immediate exclusion and normal keyboard flow", async () => {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
      for (let cycle = 0; cycle < 3; cycle++) { await open(); await immediateEscapeTab(); }
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });
    await t.test("unmount cleans up without network, hydration errors or late focus changes", async () => {
      await open();
      await page.evaluate(() => window.navigationQA.unmount());
      await page.locator("#after-shell").focus(); await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "after-shell");
      assert.equal(await page.evaluate(() => document.getElementById("root")!.childElementCount), 0);
      assert.deepEqual(await page.evaluate(() => window.navigationQA.hydrationErrors), []);
      assert.deepEqual(problems, []); assert.deepEqual(unexpectedRequests, []);
      t.diagnostic(`Immediate Escape -> Tab sequences passed: ${immediateSequences}; RPC/network requests=0; console/hydration errors=0.`);
    });
  } finally { await browser.close(); }
});

declare global {
  interface Window { navigationQA: { stages: string[]; hydrationErrors: string[]; unmount(): void }; }
}
