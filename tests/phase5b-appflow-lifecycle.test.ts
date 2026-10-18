import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import type { AppFlowQA } from "./fixtures/phase5b-appflow-harness";

interface Locator {
  click(): Promise<void>; count(): Promise<number>; isDisabled(): Promise<boolean>;
  inputValue(): Promise<string>; innerText(): Promise<string>; press(key: string): Promise<void>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
}
interface Page {
  addInitScript(options: { content: string }): Promise<void>;
  goto(url: string): Promise<unknown>; reload(): Promise<unknown>; close(): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>; addStyleTag(options: { content: string }): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<Awaited<T>>;
  waitForFunction(expression: string): Promise<unknown>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  locator(selector: string): Locator;
  on(event: string, callback: (value: { type(): string; text(): string }) => void): void;
}
interface Route {
  request(): { url(): string }; fulfill(options: { status: number; contentType: string; body: string }): Promise<void>;
  abort(): Promise<void>;
}
interface Context {
  cookies(): Promise<unknown[]>; newPage(): Promise<Page>; close(): Promise<void>;
  route(pattern: string, cb: (route: Route) => Promise<void>): Promise<void>;
}
interface Runtime { chromium: { executablePath(): string;
  launchPersistentContext(directory: string, options: { headless: boolean; executablePath: string; serviceWorkers: string; args: string[] }): Promise<Context>;
} }
declare global { interface Window { phase5bApp: AppFlowQA } }

test("Phase 5B: actual AppFlow, browser vault and active backup/removal UI without external transport", { timeout: 120_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const bundled = path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  const runtime = require(process.env.PLAYWRIGHT_MODULE_PATH ?? (existsSync(bundled) ? bundled : "playwright")) as Runtime;
  const executablePath = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  assert.ok(executablePath, "Installed Chromium required; this test does not install or silently skip");
  const fixture = path.resolve("tests/fixtures/phase5b-appflow-harness.tsx").replaceAll("\\", "/");
  const output = await build({ entryPoints: [fixture], bundle: true, write: false, outdir: "unused-test-output",
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "phase5b-client-only-boundary", setup(api) {
      api.onResolve({ filter: /(?:lib\/thru\/client|\.\/client|\.\.\/thru\/client)$/ }, (args) => {
        const full = args.path.startsWith("@/") ? path.resolve(args.path.slice(2)) : path.resolve(args.resolveDir, args.path);
        if (full.replaceAll("\\", "/").endsWith("/lib/thru/client")) return { path: full, namespace: "qa-client" };
      });
      api.onLoad({ filter: /.*/, namespace: "qa-client" }, () => ({ contents:
        `import {boundary} from ${JSON.stringify(fixture)}; export {boundary as thru} from ${JSON.stringify(fixture)};
         export const THRU_RPC_URL='http://127.0.0.1:9/blocked';
         export function createThruAccountReader(){return boundary.accounts}`, loader: "ts", resolveDir: process.cwd() }));
    } }] });
  const directory = mkdtempSync(path.join(tmpdir(), "thru-phase5b-appflow-"));
  const origin = `http://127.0.0.1:${31_000 + parseInt(randomUUID().slice(0, 4), 16) % 20_000}`;
  const runnerAttempts: string[] = [];
  const previousFetch = globalThis.fetch;
  const requestHTTP = http.request, getHTTP = http.get, requestHTTPS = https.request, getHTTPS = https.get;
  const socketConnect = net.Socket.prototype.connect;
  const blocked = () => { runnerAttempts.push("blocked-runner-egress"); throw new Error("External runner transport forbidden in Phase 5B"); };
  globalThis.fetch = blocked;
  http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
  net.Socket.prototype.connect = (function (this: net.Socket, ...args: unknown[]) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const pipe = typeof input === "string" ? input : typeof input === "object" && input !== null && "path" in input
      ? (input as { path?: unknown }).path : null;
    if (typeof pipe === "string" && (pipe.startsWith("\\\\.\\pipe\\") || path.isAbsolute(pipe))) return Reflect.apply(socketConnect, this, args);
    return blocked();
  }) as typeof socketConnect;
  syncBuiltinESMExports();
  let context: Context | undefined;
  try {
    context = await runtime.chromium.launchPersistentContext(path.join(directory, "profile"), { headless: true, executablePath,
      serviceWorkers: "block", args: ["--no-first-run", "--disable-extensions", "--disable-sync", "--disable-background-networking",
        "--disable-component-update", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"] });
    assert.deepEqual(await context.cookies(), []);
    const unexpected: string[] = [], pageErrors: number[] = [], consoleProblems: number[] = [];
    await context.route("**/*", async (route) => {
      if (route.request().url() === `${origin}/`) await route.fulfill({ status: 200, contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
      else { unexpected.push(new URL(route.request().url()).origin); await route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    await page.addInitScript({ content: `
      const deny=()=>{throw new Error('Phase 5B denies browser network escape hatches')};
      window.WebSocket=deny;window.EventSource=deny;navigator.sendBeacon=deny;
    ` });
    // Count only: never dump console/page errors that could contain a fixture.
    page.on("pageerror", () => pageErrors.push(1));
    page.on("console", (message) => { if (["error", "warning"].includes(message.type())) consoleProblems.push(1); });
    await page.goto(origin);
    assert.deepEqual(await page.evaluate(async () => ({ secure: isSecureContext, subtle: !!crypto.subtle,
      local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).length })),
    { secure: true, subtle: true, local: 0, session: 0, databases: 0 });

    const install = async () => {
      await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
      for (const file of output.outputFiles) {
        if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
        else if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
      }
    };
    const mount = () => page.evaluate(() => window.phase5bApp.mount());
    const ready = () => page.waitForFunction("document.body.textContent.includes('Workspace Unlocked')");
    const empty = () => page.waitForFunction("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Create Wallet')");
    const reset = async () => { await page.evaluate(() => window.phase5bApp.reset()); await mount(); await empty(); };
    const stats = () => page.evaluate(() => window.phase5bApp.stats());
    const totals: ReturnType<AppFlowQA["stats"]> = { height: 0, inventory: 0, account: 0, history: 0, generate: 0,
      forbidden: 0, downloads: 0, objectURLs: 0, revokedURLs: 0, removals: 0 };
    const accumulate = async () => { const current = await stats(); for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += current[key]; };
    const reload = async () => { await accumulate(); await page.reload(); await install(); await mount(); };
    const openImport = async () => {
      await page.getByRole("button", { name: "Import Wallet", exact: true }).click();
      await page.getByRole("button", { name: "Backup File", exact: true }).click();
    };
    await install(); await mount(); await empty();

    await t.test("new isolated origin starts without a wallet and every write/sign boundary is trapped", async () => {
      assert.equal(await page.getByRole("button", { name: "Wallet actions", exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => window.phase5bApp.nativeGate()), false);
      assert.equal((await stats()).forbidden, 0);
      assert.deepEqual(await page.evaluate(() => window.phase5bApp.stored()), { present: false, matches: false, pending: false });
    });
    await t.test("synthetic Create waits for persistence, keeps setupPending on reload, and verifies Continue", async () => {
      await page.evaluate(() => { window.phase5bApp.generationHold(); window.phase5bApp.persistenceHold(); });
      await page.getByRole("button", { name: "Create Wallet", exact: true }).click();
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
      await page.evaluate(() => window.phase5bApp.releaseGeneration());
      await page.waitForFunction("window.phase5bApp.verificationHeld()");
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Wallet actions", exact: true }).isDisabled(), true);
      await page.evaluate(() => window.phase5bApp.releaseVerification());
      await page.waitForFunction("document.body.textContent.includes('Save your private key')");
      assert.deepEqual(await page.evaluate(() => window.phase5bApp.stored()), { present: true, matches: true, pending: true });
      assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Reveal private key" }).count(), 1);
      await reload();
      await page.waitForFunction("document.body.textContent.includes('Save your private key')");
      await page.getByRole("checkbox", { name: "I have saved my private key safely." }).click();
      await page.evaluate(() => window.phase5bApp.writeFailure(true));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.waitForFunction("document.body.textContent.includes('Unable to finish wallet setup securely')");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).pending, true);
      await page.evaluate(() => window.phase5bApp.writeFailure(false));
      await page.evaluate(() => window.phase5bApp.abortWrite("wallet"));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.waitForFunction("document.body.textContent.includes('Unable to finish wallet setup securely')");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).pending, true, "Aborted marker update must not complete setup");
      await page.getByRole("button", { name: "Continue", exact: true }).click(); await ready();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).pending, false);
      await reload(); await ready();
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
    });
    await t.test("Popover cancel preserves records; confirm uses verified deletion and preserves unrelated storage", async () => {
      await page.evaluate(() => localStorage.setItem("phase5b.unrelated", "public-sentinel"));
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Wallet actions", exact: true });
      await dialog.getByRole("button", { name: "Remove from device", exact: true }).click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, true);
      await dialog.getByRole("button", { name: "Remove from device", exact: true }).click();
      await page.evaluate(() => window.phase5bApp.deletionFailure(true));
      await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
      await page.waitForFunction("document.body.textContent.includes('Unable to remove the wallet')");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      await page.evaluate(() => window.phase5bApp.deletionFailure(false));
      await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click(); await empty();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
      assert.equal(await page.evaluate(() => localStorage.getItem("phase5b.unrelated")), "public-sentinel");
      await reload(); await empty();
    });
    await t.test("Dashboard removal requires explicit confirmation; Cancel/Escape preserve wallet and restore keyboard focus", async () => {
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("b")); await mount(); await ready();
      const before = (await stats()).removals;
      const trigger = page.getByRole("button", { name: "Remove", exact: true });
      await trigger.click();
      const group = page.getByRole("group", { name: "Remove wallet from this device?", exact: true });
      assert.match(await group.innerText(), /browser only[\s\S]*safe backup/);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal((await stats()).removals, before, "Initial Remove must not invoke deletion");
      await group.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await group.count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Remove");
      await trigger.press("Enter");
      await group.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
      assert.equal(await group.count(), 0);
      assert.equal((await stats()).removals, before, "Escape must never delete");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Remove");
      await trigger.click();
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      assert.equal(await group.count(), 0, "Opening another wallet surface dismisses confirmation without deleting");
      assert.equal((await stats()).removals, before);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      await page.getByRole("dialog", { name: "Wallet actions", exact: true }).press("Escape");
      await trigger.press("Space");
      await group.getByRole("button", { name: "Confirm removal", exact: true }).press("Enter"); await empty();
      assert.equal((await stats()).removals, before + 1);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
      t.diagnostic("Approved removal policy: initial pointer/keyboard action, Cancel and Escape delete nothing; explicit confirmation performs one verified removal.");
    });
    await t.test("Dashboard deletion failure must preserve the wallet and handle rejection without an uncaught exception", async () => {
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("a")); await mount(); await ready();
      const before = pageErrors.length;
      await page.evaluate(() => window.phase5bApp.deletionFailure(true));
      try {
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
        await page.waitForFunction("document.querySelector('#dashboard-wallet-removal [role=alert]')?.textContent === 'Unable to remove the wallet from this device. Try again.'");
        assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
        assert.match(await page.locator("body").innerText(), /Workspace Unlocked/);
        assert.equal(pageErrors.length, before, "Active Dashboard must catch a rejected verified deletion and show a safe error");
        assert.equal(await page.getByRole("button", { name: "Confirm removal", exact: true }).isDisabled(), false);
      } finally { await page.evaluate(() => window.phase5bApp.deletionFailure(false)); }
      await page.getByRole("button", { name: "Confirm removal", exact: true }).click(); await empty();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false, "Controlled retry must complete verified deletion");
    });
    for (const store of ["device", "wallet"] as const) await t.test(`AppFlow rejects a real ${store} transaction abort without activating the fixture`, async () => {
      await reset();
      await page.evaluate((value) => window.phase5bApp.abortWrite(value), store);
      await page.getByRole("button", { name: "Create Wallet", exact: true }).click();
      await page.waitForFunction("document.body.textContent.includes('Unable to save the wallet securely')");
      assert.equal(await page.getByRole("button", { name: "Wallet actions", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      assert.doesNotMatch(await page.locator("body").innerText(), /Workspace Unlocked/);
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
      assert.equal(pageErrors.length, 0);
    });
    await t.test("Dashboard double confirmation starts one removal and waits for verified absence before clearing UI", async () => {
      await page.evaluate(() => window.phase5bApp.reset());
      await page.evaluate(() => window.phase5bApp.seed("a")); await mount(); await ready();
      const before = (await stats()).removals;
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.evaluate(() => {
        window.phase5bApp.restoreHold();
        const button = document.querySelector<HTMLButtonElement>('#dashboard-wallet-removal button')!;
        button.click(); button.click();
      });
      await page.waitForFunction("window.phase5bApp.verificationHeld()");
      assert.equal((await stats()).removals, before + 1);
      assert.match(await page.locator("body").innerText(), /Workspace Unlocked/);
      const group = page.getByRole("group", { name: "Remove wallet from this device?", exact: true });
      assert.equal(await group.getByRole("button", { name: "Removing...", exact: true }).isDisabled(), true);
      assert.equal(await group.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Wallet actions", exact: true }).isDisabled(), true);
      await group.press("Escape"); assert.equal(await group.count(), 1);
      await page.evaluate(() => window.phase5bApp.releaseVerification()); await empty();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
    });
    await t.test("Popover double confirmation keeps its cancellation policy and blocks competing controls while removal is pending", async () => {
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("a")); await mount(); await ready();
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Wallet actions", exact: true });
      await dialog.getByRole("button", { name: "Remove from device", exact: true }).click();
      const before = (await stats()).removals;
      await page.evaluate(() => {
        window.phase5bApp.restoreHold();
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#command-wallet-actions button')).find((candidate) => candidate.textContent?.trim() === "Confirm removal")!;
        button.click(); button.click();
      });
      await page.waitForFunction("window.phase5bApp.verificationHeld()");
      assert.equal((await stats()).removals, before + 1);
      assert.equal(await dialog.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
      assert.equal(await dialog.getByRole("button", { name: "Download Backup", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Remove", exact: true }).isDisabled(), true);
      await page.evaluate(() => window.phase5bApp.releaseVerification()); await empty();
      assert.equal(pageErrors.length, 0);
    });
    await t.test("wallet scope change clears Dashboard confirmation/error and ignores a late rejected removal", async () => {
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("a")); await mount(); await ready();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.evaluate(() => window.phase5bApp.deletionFailure(true));
      await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
      await page.waitForFunction("!!document.querySelector('#dashboard-wallet-removal [role=alert]')");
      await page.evaluate(() => { window.phase5bApp.deletionFailure(false); window.phase5bApp.unmount(); });
      await page.evaluate(() => window.phase5bApp.seed("b")); await mount(); await ready();
      assert.equal(await page.getByRole("group", { name: "Remove wallet from this device?", exact: true }).count(), 0);
      assert.doesNotMatch(await page.locator("body").innerText(), /Unable to remove the wallet/);
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.evaluate(() => window.phase5bApp.restoreHold());
      await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
      await page.waitForFunction("window.phase5bApp.verificationHeld()");
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("a")); await mount(); await ready();
      await page.evaluate(() => window.phase5bApp.releaseVerification(true));
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      const ids = await page.evaluate(() => window.phase5bApp.publicIdentities());
      assert.ok((await page.locator("body").innerText()).includes(ids.a.slice(0, 8)));
      assert.equal(await page.getByRole("group", { name: "Remove wallet from this device?", exact: true }).count(), 0);
      assert.doesNotMatch(await page.locator("body").innerText(), /Unable to remove the wallet/);
      assert.equal(pageErrors.length, 0);
    });
    for (const mode of ["missing-key", "schema"] as const) await t.test(`real AppFlow ${mode} restore remains VAULT_ERROR, never empty-vault recovery`, async () => {
      await page.evaluate(() => window.phase5bApp.reset());
      await page.evaluate(() => window.phase5bApp.seed("a"));
      await page.evaluate((value) => window.phase5bApp.mutateVault(value), mode);
      await mount();
      await page.waitForFunction("document.body.textContent.includes('The saved wallet could not be opened')");
      assert.equal(await page.getByRole("button", { name: "Create Wallet", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Import Wallet", exact: true }).count(), 0);
    });
    for (const mode of ["tampered", "identity", "wrong-password"] as const) await t.test(`active backup import rejects ${mode} and clears file/password without activation`, async () => {
      await reset(); await openImport();
      await page.evaluate((value) => window.phase5bApp.importFile(2, value === "wrong-password" ? "valid" : value, value === "wrong-password"), mode);
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click();
      await empty();
      await page.waitForFunction("document.body.textContent.includes('Unable') || document.body.textContent.includes('does not match its wallet address')");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).present, false);
      await openImport(); assert.equal(await page.evaluate(() => window.phase5bApp.inputsEmpty()), true);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    });
    await t.test("backup import persistence failure stays VAULT_ERROR without wallet activation", async () => {
      await reset(); await openImport();
      await page.evaluate(() => window.phase5bApp.importFile(2));
      await page.evaluate(() => window.phase5bApp.writeFailure(true));
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click();
      await page.waitForFunction("document.body.textContent.includes('Unable to save the wallet securely')");
      assert.equal(await page.getByRole("button", { name: "Create Wallet", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Wallet actions", exact: true }).isDisabled(), true);
      await page.evaluate(() => window.phase5bApp.writeFailure(false));
    });
    for (const version of [1, 2] as const) await t.test(`real active V${version} backup import, public catalog and reload restore same identity`, async () => {
      await reset(); await page.evaluate(() => window.phase5bApp.select("a")); await openImport();
      await page.evaluate((value) => window.phase5bApp.importFile(value), version);
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click(); await ready();
      assert.deepEqual(await page.evaluate(() => window.phase5bApp.stored()), { present: true, matches: true, pending: false });
      assert.equal(await page.evaluate(() => window.phase5bApp.inputsEmpty()), true);
      assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes("Public QA catalog"))), true);
      await reload(); await ready();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
    });
    await t.test("private-key import uses actual production parser, activates verified fixture B and clears controls", async () => {
      await reset(); await page.evaluate(() => window.phase5bApp.select("b"));
      await page.getByRole("button", { name: "Import Wallet", exact: true }).click();
      await page.evaluate(() => window.phase5bApp.fillPrivateImport());
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click(); await ready();
      const ids = await page.evaluate(() => window.phase5bApp.publicIdentities());
      const body = await page.locator("body").innerText();
      assert.ok(body.includes(ids.b.slice(0, 8)), "Visible UI must show fixture B, not only the stored identity");
      assert.ok(!body.includes(ids.a.slice(0, 8)), "Fixture A must not remain in visible wallet identity");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal(await page.evaluate(() => window.phase5bApp.inputsEmpty()), true);
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      await reset(); await openImport();
      await page.evaluate(() => { window.phase5bApp.select("a"); });
      await page.evaluate(() => window.phase5bApp.importFile(2));
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click(); await ready();
    });
    await t.test("active backup warning/ack/password controls, cancel clearing and Blob URL cleanup", async () => {
      await page.getByRole("checkbox", { name: "I understand the security risks." }).click();
      await page.getByRole("button", { name: "Download Encrypted Backup", exact: true }).click();
      let dialog = page.getByRole("dialog", { name: "Create wallet JSON backup" });
      assert.match(await dialog.innerText(), /does not protect the visible plaintext privateKey field/);
      const download = dialog.getByRole("button", { name: "Download JSON backup", exact: true });
      assert.equal(await download.isDisabled(), true);
      await page.evaluate(() => window.phase5bApp.fillBackupPasswords(true)); assert.equal(await download.isDisabled(), true);
      await page.evaluate(() => window.phase5bApp.fillBackupPasswords()); assert.equal(await download.isDisabled(), true);
      await dialog.getByRole("checkbox").click(); assert.equal(await download.isDisabled(), false);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Download Encrypted Backup", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Create wallet JSON backup" });
      assert.equal(await page.evaluate(() => window.phase5bApp.inputsEmpty()), true);
      await page.evaluate(() => window.phase5bApp.fillBackupPasswords());
      await dialog.getByRole("checkbox").click();
      await dialog.getByRole("button", { name: "Download JSON backup", exact: true }).click();
      await page.waitForFunction("window.phase5bApp.stats().downloads===1");
      const summary = await page.evaluate(() => window.phase5bApp.downloadSummary());
      assert.equal(summary.plaintextKeyMatches, true); assert.equal(summary.encryptedPayload, true);
      assert.equal(summary.catalog, true); assert.equal(summary.revoked, true);
      assert.deepEqual(summary.fields, ["address", "cipher", "createdAt", "format", "kdf", "privateKey", "version", "walletAddress"]);
      assert.equal(await page.locator("a[download]").count(), 0);
      t.diagnostic(`Download API counts: created=${(await stats()).objectURLs}, revoked=${(await stats()).revokedURLs}, intercepted=${(await stats()).downloads}; no file written.`);
    });
    await t.test("wallet B after verified removal never restores wallet A or its setup UI", async () => {
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("button", { name: "Confirm removal", exact: true }).click(); await empty();
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.seed("b")); await mount(); await ready();
      const identities = await page.evaluate(() => window.phase5bApp.publicIdentities());
      assert.ok((await page.locator("body").innerText()).includes(identities.b.slice(0, 8)));
      assert.ok(!(await page.locator("body").innerText()).includes(identities.a.slice(0, 8)));
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal(await page.getByRole("heading", { name: "Save your private key" }).count(), 0);
      await reload(); await ready();
      // A document reload resets only fixture identity, not the real stored wallet.
      await page.evaluate(() => window.phase5bApp.select("b"));
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
    });
    await t.test("catalog restoration failure cannot invalidate verified wallet import (warning gap documented)", async () => {
      await reset(); await page.evaluate(() => window.phase5bApp.select("a")); await openImport();
      await page.evaluate(() => window.phase5bApp.importFile(2));
      await page.evaluate(() => window.phase5bApp.catalogFailure(true));
      await page.getByRole("button", { name: "Confirm Import", exact: true }).click(); await ready();
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes("Public QA catalog"))), false);
      await page.evaluate(() => window.phase5bApp.catalogFailure(false));
      t.diagnostic("Persistence UX gap: wallet import succeeds, but failed public catalog restoration is not surfaced by AppFlow as a specific import warning.");
    });
    await t.test("unmount during delayed real IDB restore cannot activate a stale wallet", async () => {
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.restoreHold());
      await mount();
      await page.waitForFunction("window.phase5bApp.verificationHeld()");
      await page.evaluate(() => window.phase5bApp.unmount());
      await page.evaluate(() => window.phase5bApp.releaseVerification());
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      assert.equal(await page.locator("#root").innerText(), "");
      assert.equal((await page.evaluate(() => window.phase5bApp.stored())).matches, true);
      assert.equal((await stats()).forbidden, 0);
      assert.equal(await page.evaluate(() => window.phase5bApp.nativeGate()), false);
    });
    assert.deepEqual(unexpected, [], "No unmocked browser request permitted");
    assert.deepEqual(runnerAttempts, [], "No runner egress permitted");
    await accumulate();
    assert.equal(totals.forbidden, 0);
    t.diagnostic(`Actual mocked RPC calls across all document reloads: height=${totals.height}, inventory=${totals.inventory}, account=${totals.account}, history=${totals.history}; fixture generation=${totals.generate}; signing/submission=${totals.forbidden}; external=0.`);
    t.diagnostic(`Browser exception count=${pageErrors.length}; console error/warning count=${consoleProblems.length}; values redacted.`);
    assert.equal(pageErrors.length, 0, "No unexpected browser exceptions");
    assert.equal(consoleProblems.length, 0, "No console errors or warnings");
    await page.close();
  } finally {
    try { await context?.close(); } finally {
    globalThis.fetch = previousFetch;
    http.request = requestHTTP; http.get = getHTTP; https.request = requestHTTPS; https.get = getHTTPS;
    net.Socket.prototype.connect = socketConnect;
    syncBuiltinESMExports();
    const resolved = path.resolve(directory), parent = path.resolve(tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("thru-phase5b-appflow-"));
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
