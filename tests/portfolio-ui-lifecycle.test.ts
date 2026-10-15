import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { PortfolioQA } from "./fixtures/portfolio-ui-harness";

// No test framework/dependency install. Use an existing Playwright runtime.
// CI can provide PLAYWRIGHT_MODULE_PATH; absence is explicitly reported, never downloaded.
interface Locator {
  click(): Promise<void>; fill(value: string): Promise<void>; selectOption(value: string): Promise<void>;
  press(value: string): Promise<void>; count(): Promise<number>; inputValue(): Promise<string>;
  innerText(): Promise<string>; isDisabled(): Promise<boolean>; isVisible(): Promise<boolean>;
  first(): Locator; nth(n: number): Locator; locator(selector: string): Locator;
  focus(): Promise<void>;
  getByLabel(name: string, options?: { exact?: boolean }): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
}
interface Page {
  setDefaultTimeout(ms: number): void;
  goto(url: string): Promise<unknown>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(name: string, options?: { exact?: boolean }): Locator;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  waitForFunction(expression: string): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean; animations?: "disabled" }): Promise<unknown>;
  on(event: "pageerror", callback: (error: Error) => void): void;
  on(event: "console", callback: (message: { type(): string; text(): string }) => void): void;
}
interface Runtime { chromium: { executablePath(): string; launch(options: { headless: boolean; executablePath?: string; args?: string[] }): Promise<{
  newContext(options?: { serviceWorkers: "block" }): Promise<{ cookies(): Promise<unknown[]>; newPage(): Promise<Page>; route(pattern: string, cb: (route: {
    request(): { url(): string }; fulfill(options: { status: number; contentType?: string; body: string }): Promise<void>;
    abort(): Promise<void>;
  }) => Promise<void>): Promise<void> }>;
  close(): Promise<void>;
}> } }

test("real React portfolio lifecycle in isolated, non-networked Chromium", { timeout: 120_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const bundled = path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  let runtime: Runtime;
  try { runtime = require(process.env.PLAYWRIGHT_MODULE_PATH ?? (existsSync(bundled) ? bundled : "playwright")) as Runtime; }
  catch { t.skip("Existing Playwright unavailable; set PLAYWRIGHT_MODULE_PATH to run browser lifecycle coverage."); return; }
  const candidates = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
  const executablePath = candidates.find(existsSync);
  if (!executablePath) { t.skip("No installed Chromium; this test never installs a browser."); return; }
  const fixture = path.resolve("tests/fixtures/portfolio-ui-harness.tsx").replaceAll("\\", "/");
  const bundles = await build({ entryPoints: [fixture], bundle: true, write: false, outdir: "unused-test-output",
    // Exercise the shipped React runtime. React's development performance profiler
    // traverses previous props (including deliberately throwing getter sentinels).
    // Keep those sentinels intact so any application read still fails this test.
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "read-only-test-boundaries", setup(api) {
      api.onLoad({ filter: /lib[\\/]thru[\\/]network\.ts$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8").replace("Object.freeze({", "({"), loader: "ts",
      }));
      api.onResolve({ filter: /\?actual$/ }, (args) => ({ path: args.path.replace(/\?actual$/, "") }));
      api.onResolve({ filter: /(?:\/discovery|\/thru-token|\/useTokenTransfer|\/CommandActivity|\/TokenCreateForm)$/ }, (args) => {
        const full = args.path.startsWith("@/") ? path.resolve(args.path.slice(2)) : path.resolve(args.resolveDir, args.path);
        return { path: full, namespace: "boundary" };
      });
      api.onLoad({ filter: /.*/, namespace: "boundary" }, (args) => {
        const full = args.path.replaceAll("\\", "/");
        const name = path.basename(full);
        if (name === "CommandActivity" || name === "TokenCreateForm") return { contents: "export default function UnrelatedSurface(){return null}", loader: "js" };
        const prelude = `import {boundary} from ${JSON.stringify(fixture)};`;
        if (name === "useTokenTransfer") return { contents: prelude + `
          import {useCallback,useRef,useSyncExternalStore} from 'react'; const resetState=()=>{};
          export function useTokenTransfer({onSuccess}) {
            const current=useRef(onSuccess); current.current=onSuccess;
            const state=useSyncExternalStore(boundary.subscribe,boundary.transferSnapshot,boundary.transferSnapshot);
            const transfer=useCallback(async(args)=>boundary.send(args,current.current),[]);
            return {...state,result:null,transfer,resetState};
          }`, loader: "js", resolveDir: process.cwd() };
        return { contents: `export * from ${JSON.stringify(full + ".ts?actual")};` + prelude + (name === "discovery"
          ? "export const discoverWalletHoldingsOnce=(wallet,options)=>boundary.discover(wallet,options);"
          : "export const discoverControlledTokensOnBetanet=(wallet)=>boundary.created(wallet); export const fetchTokenPortfolioOnBetanet=(records)=>boundary.portfolio(records);"),
          loader: "js", resolveDir: process.cwd() };
      });
    } }] });
  // launch() owns a new temporary Chromium profile; never launchPersistentContext
  // against any installed user's profile. The context has no imported session.
  const browser = await runtime.chromium.launch({ headless: true, executablePath, args: ["--disable-extensions", "--disable-sync"] });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    assert.deepEqual(await context.cookies(), [], "New context must have no existing cookies");
    const unexpected: string[] = [], errors: string[] = [], consoleProblems: string[] = [];
    await context.route("**/*", async (route) => {
      if (route.request().url() === "http://portfolio.test/") await route.fulfill({ status: 200, contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>' });
      else { unexpected.push(new URL(route.request().url()).hostname); await route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.on("pageerror", (error) => { errors.push(error.message); t.diagnostic(`Browser exception: ${error.stack}`); });
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") consoleProblems.push(message.text()); });
    await page.goto("http://portfolio.test/");
    assert.deepEqual(await page.evaluate(async () => ({ origin: location.origin, local: localStorage.length,
      session: sessionStorage.length, databases: (await indexedDB.databases()).length })),
      { origin: "http://portfolio.test", local: 0, session: 0, databases: 0 });
    const screenshotDirectory = process.env.THRU_PORTFOLIO_QA_ARTIFACT_DIR;
    if (screenshotDirectory) {
      const relative = path.relative(process.cwd(), path.resolve(screenshotDirectory));
      assert.ok(path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`), "QA artifacts must stay outside repository");
    }
    const screenshot = async (name: string) => {
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true, animations: "disabled" });
    };
    await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
    for (const output of bundles.outputFiles) {
      if (output.path.endsWith(".css")) await page.addStyleTag({ content: output.text });
      else if (output.path.endsWith(".js")) await page.addScriptTag({ content: output.text });
    }
    await page.waitForFunction("window.portfolioQA && document.body.textContent.includes('Saved unconfirmed')");
    const ids = await page.evaluate(() => window.portfolioQA.ids);
    const stats = () => page.evaluate(() => window.portfolioQA.stats());
    const assets = page.getByRole("region", { name: "My Holdings" });
    await t.test("fresh browser has one bounded discovery lifecycle, and Continue does not restart creator history", async () => {
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      const initial = await stats();
      assert.equal(initial.reads, 1); assert.equal(initial.createdReads, 1); assert.equal(initial.portfolioReads, 1);
      const before = await stats();
      await page.getByRole("button", { name: "Continue discovery", exact: true }).click();
      await page.waitForFunction(`window.portfolioQA.stats().portfolioReads === ${before.portfolioReads + 1}`);
      const after = await stats();
      assert.equal(after.reads, before.reads + 1); assert.equal(after.createdReads, before.createdReads);
      assert.equal(after.continuations, before.continuations + 1);
      t.diagnostic(`Mock initial reads: inventory=${initial.reads}, creator-history=${initial.createdReads}, catalog=${initial.portfolioReads}; Continue delta: 1/0/1`);
    });
    await t.test("shared real model renders holdings, control roles, saved references and exact distinct accounts", async () => {
      assert.match(await assets.innerText(), /2 source accounts/);
      assert.match(await assets.innerText(), new RegExp(ids.mint));
      assert.match(await assets.innerText(), new RegExp(ids.secondMint));
      assert.match(await page.getByRole("region", { name: "Created / Controlled Tokens" }).innerText(), /Creator only[\s\S]*Authority only/);
      const saved = await page.getByRole("region", { name: "Saved References" }).innerText();
      assert.match(saved, /Saved unconfirmed/); assert.match(saved, /Ownership not confirmed/);
      await assets.locator("summary").first().click();
      assert.match(await assets.innerText(), new RegExp(ids.custom));
      assert.match(await assets.innerText(), /Observed balance: 7[\s\S]*Observed balance: 9/);
      assert.doesNotMatch(await assets.innerText(), /Observed balance: 16/);
    });
    await t.test("opening/closing popover starts zero independent discovery lifecycles", async () => {
      const before = (await stats()).reads;
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
        assert.match(await page.getByRole("dialog", { name: "Wallet actions" }).innerText(), /Saved unconfirmed/);
        await page.getByRole("dialog").press("Escape");
      }
      assert.equal((await stats()).reads, before);
      t.diagnostic("Popover open/close x2: inventory=0, creator-history=0, catalog=0 additional reads");
    });
    await t.test("keyboard account details and popover focus work without starting reads", async () => {
      const before = await stats();
      const summary = assets.locator("summary").first();
      await summary.focus();
      if (await page.evaluate(() => document.querySelector('[aria-label="My Holdings"] details')?.hasAttribute("open"))) await summary.press("Enter");
      await summary.press("Enter");
      assert.equal(await page.evaluate(() => document.querySelector('[aria-label="My Holdings"] details')?.hasAttribute("open")), true);
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle !== "none"), true);
      await summary.press("Space");
      assert.equal(await page.evaluate(() => document.querySelector('[aria-label="My Holdings"] details')?.hasAttribute("open")), false);
      const trigger = page.getByRole("button", { name: "Wallet actions", exact: true });
      await trigger.focus(); await trigger.press("Enter");
      await page.waitForFunction("document.activeElement?.getAttribute('role') === 'dialog'");
      await page.getByRole("dialog").press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Wallet actions");
      assert.equal((await stats()).reads, before.reads);
    });
    await t.test("popover Receive uses public identity, and busy transfer blocks close and wallet actions", async () => {
      const before = await stats();
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Wallet actions" });
      await dialog.getByRole("button", { name: "Receive", exact: true }).click();
      assert.match(await dialog.innerText(), new RegExp(ids.wallet));
      assert.equal((await stats()).secretReads, 0);
      await page.evaluate(() => window.portfolioQA.transferState(true));
      try {
        await page.waitForFunction("document.querySelector('[role=dialog]')?.getAttribute('aria-busy') === 'true'");
        assert.equal(await dialog.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
        assert.equal(await dialog.getByRole("button", { name: "Download Backup", exact: true }).isDisabled(), true);
        assert.equal(await dialog.getByRole("button", { name: /Remove/ }).isDisabled(), true);
        await dialog.press("Escape");
        assert.equal(await dialog.count(), 1);
      } finally { await page.evaluate(() => window.portfolioQA.transferState(false)); }
      await dialog.press("Escape");
      assert.equal((await stats()).reads, before.reads); assert.equal((await stats()).writes, 0);
    });
    await t.test("native zero, unknown and uint64 display agree in Dashboard and popover", async () => {
      for (const value of [null, "0", "18446744073709551615"]) {
        // The evaluated object contains public UI state only.
        await page.evaluate(() => window.portfolioQA.balance(null));
        if (value === "0") await page.evaluate(() => window.portfolioQA.balance("0"));
        if (value && value !== "0") await page.evaluate(() => window.portfolioQA.balance("18446744073709551615"));
        await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
        const expected = value === null ? "Unavailable" : `${value} native units`;
        assert.match(await page.getByRole("dialog").innerText(), new RegExp(expected));
        assert.match(await page.locator("main").innerText(), new RegExp(expected));
        await page.getByRole("dialog").press("Escape");
      }
    });
    await t.test("MAX uses chosen source only and successful Send refreshes root exactly once", async () => {
      await page.getByLabel("Asset", { exact: true }).selectOption(ids.mint);
      await page.getByLabel("Balance source · one token account").selectOption(ids.custom);
      await page.getByRole("button", { name: "MAX", exact: true }).click();
      assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "9");
      await page.getByLabel("Recipient", { exact: true }).fill(ids.other);
      const before = await stats();
      await page.getByRole("button", { name: "Review Send", exact: true }).click();
      await page.waitForFunction(`window.portfolioQA.stats().reads === ${before.reads + 1}`);
      assert.equal((await stats()).sends, before.sends + 1);
      assert.equal((await stats()).reads, before.reads + 1);
      assert.deepEqual((await stats()).lastSend, { selectedTokenMint: ids.mint, transferSource: ids.custom,
        transferDestination: ids.other, transferAmount: "9" });
      t.diagnostic("Dashboard successful mock Send: root inventory refresh=1; actual custom source amount=9, never aggregate=16");
    });
    await t.test("removed selected source cannot carry its amount to another account", async () => {
      await page.getByLabel("Balance source · one token account").selectOption(ids.custom);
      await page.getByLabel("Amount", { exact: true }).fill("8");
      await page.evaluate(() => window.portfolioQA.phase("missing-source"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("document.getElementById('quick-send-amount').value === ''");
      assert.equal(await page.getByRole("button", { name: "Review Send", exact: true }).isDisabled(), true);
    });
    await t.test("popover Send refreshes the shared owner once, without mounting another discovery owner", async () => {
      const before = await stats();
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Wallet actions" });
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      await dialog.getByLabel("Asset", { exact: true }).selectOption(ids.mint);
      await dialog.getByLabel("Recipient THRU address", { exact: true }).fill(ids.other);
      await dialog.getByLabel("Amount", { exact: true }).fill("1");
      assert.equal((await stats()).reads, before.reads);
      await dialog.getByRole("button", { name: "Send Token", exact: true }).click();
      await page.waitForFunction(`window.portfolioQA.stats().reads === ${before.reads + 1}`);
      assert.equal((await stats()).sends, before.sends + 1);
      await dialog.press("Escape");
    });
    await t.test("wallet change/removal/restore resets mint/source/form; delayed old wallet callback is inert", async () => {
      await page.getByLabel("Amount", { exact: true }).fill("6");
      await page.getByLabel("Recipient", { exact: true }).fill(ids.wallet);
      await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
      const beforeSwitch = await stats();
      await page.evaluate(() => window.portfolioQA.wallet("b"));
      await page.waitForFunction("document.getElementById('quick-send-amount').value === ''");
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      assert.equal(await page.getByRole("dialog", { name: "Wallet actions" }).count(), 0);
      assert.equal(await page.getByLabel("Recipient", { exact: true }).inputValue(), "");
      const switched = await stats();
      assert.equal(switched.reads, beforeSwitch.reads + 1);
      assert.equal(switched.createdReads, beforeSwitch.createdReads + 1);
      assert.equal(switched.portfolioReads, beforeSwitch.portfolioReads + 1);
      const count = (await stats()).reads;
      await page.evaluate(() => window.portfolioQA.lateSuccess());
      assert.equal((await stats()).reads, count);
      await page.evaluate(() => window.portfolioQA.wallet("none"));
      await page.waitForFunction("document.body.textContent.includes('Create Wallet')");
      assert.equal(await page.getByRole("region", { name: "My Holdings" }).count(), 0);
      assert.equal((await stats()).reads, count);
      await page.evaluate(() => window.portfolioQA.wallet("a"));
      await page.waitForFunction("document.body.textContent.includes('Saved unconfirmed')");
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      assert.equal((await stats()).reads, count + 1);
      t.diagnostic("Wallet A -> B: inventory/history/catalog=1/1/1; removal=0 reads; restoration=1 inventory read; old callback=0 reads");
    });
    await t.test("Token Studio shares root read lifecycle, preserves search, Create and source-specific Send", async () => {
      const before = (await stats()).reads;
      await page.getByRole("button", { name: /Tokens$/ }).click();
      await page.waitForFunction("document.body.textContent.includes('My Tokens')");
      assert.equal((await stats()).reads, before);
      t.diagnostic("Dashboard -> Token Studio navigation: 0 additional inventory/creator/catalog reads");
      assert.equal(await page.evaluate(() => document.body.textContent!.split("Betanet RPC is currently unavailable. Try again later.").length - 1), 1,
        "Shared discovery status announces a portfolio read error once, without a duplicate sidebar error");
      await page.getByLabel("Search tokens by label, mint or account").fill(ids.mint);
      assert.equal(await page.locator(".pc-token-list-item").count(), 1);
      await page.locator(".pc-token-list-item").click();
      assert.match(await page.getByRole("region", { name: "Selected token details" }).innerText(), new RegExp(ids.mint));
      assert.equal(await page.getByRole("button", { name: "Create New", exact: true }).isDisabled(), false);
      await page.getByLabel("Recipient THRU address", { exact: true }).fill(ids.other);
      await page.getByLabel("Amount", { exact: true }).fill("1");
      const sending = await stats();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(`window.portfolioQA.stats().reads === ${sending.reads + 1}`);
      assert.equal((await stats()).sends, sending.sends + 1);
      await page.getByLabel("Search tokens by label, mint or account").fill("");
    });
    await t.test("token zero, unknown account balance and unknown verification time stay distinct", async () => {
      await page.evaluate(() => window.portfolioQA.phase("zero"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      await page.getByLabel("Search tokens by label, mint or account").fill(ids.mint);
      await page.locator(".pc-token-list-item").click();
      const details = page.getByRole("region", { name: "Selected token details" });
      await details.locator("summary").click();
      assert.match(await details.innerText(), /Observed balance: 0/);
      await page.evaluate(() => window.portfolioQA.phase("unknown-balance"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      await page.getByLabel("Search tokens by label, mint or account").fill(ids.creatorMint);
      await page.locator(".pc-token-list-item").click();
      assert.match(await details.innerText(), /Observed balance: Unavailable/);
      assert.match(await details.innerText(), /Observed at: Unknown/);
      assert.doesNotMatch(await details.innerText(), /Fresh observation/);
      await page.getByLabel("Search tokens by label, mint or account").fill("");
    });
    await t.test("expired source cannot be sent and failed refresh preserves public cache with safe errors", async () => {
      await page.evaluate(() => window.portfolioQA.phase("expired"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      await page.getByLabel("Search tokens by label, mint or account").fill(ids.mint);
      await page.locator(".pc-token-list-item").click();
      await page.getByLabel("Recipient THRU address", { exact: true }).fill(ids.other);
      await page.getByLabel("Amount", { exact: true }).fill("1");
      assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
      const before = await stats();
      await page.evaluate(() => window.portfolioQA.phase("failed"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.mint));
      assert.doesNotMatch(await page.locator("body").innerText(), /Synthetic transport failure|internal details/);
      assert.equal((await stats()).reads, before.reads + 1); assert.equal((await stats()).sends, before.sends);
      assert.equal((await stats()).createdReads, before.createdReads);
      assert.equal((await stats()).portfolioReads, before.portfolioReads);
      t.diagnostic("Failed Refresh: inventory/history/catalog=1/0/0; writes=0; prior public holdings retained");
      await page.evaluate(() => window.portfolioQA.phase("live"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      await page.getByLabel("Search tokens by label, mint or account").fill("");
    });
    await t.test("offline retains cached assets but never displays native zero or enables Send", async () => {
      await page.evaluate(() => window.portfolioQA.health("Offline"));
      await page.waitForFunction("document.body.textContent.includes('RPC unavailable')");
      assert.match(await page.locator("body").innerText(), /Cached public observation/);
      assert.equal(await page.getByRole("button", { name: "Refresh discovery" }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Create New", exact: true }).isDisabled(), true);
      await page.getByLabel("Search tokens by label, mint or account").fill("SAME");
      assert.ok(await page.locator(".pc-token-list-item").count() > 0);
      await page.evaluate(() => window.portfolioQA.health("Online"));
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
    });
    await t.test("provisional/frozen observations stay visible but cannot expand Send eligibility", async () => {
      if (!await page.evaluate(() => document.querySelector('[aria-label="Selected token details"] details')?.hasAttribute("open")))
        await page.getByRole("region", { name: "Selected token details" }).locator("summary").click();
      await page.getByLabel("Recipient THRU address", { exact: true }).fill(ids.other);
      await page.getByLabel("Amount", { exact: true }).fill("1");
      for (const value of ["provisional", "frozen"] as const) {
        if (value === "provisional") await page.evaluate(() => window.portfolioQA.phase("provisional"));
        else await page.evaluate(() => window.portfolioQA.phase("frozen"));
        await page.getByRole("button", { name: "Refresh discovery" }).click();
        await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
        assert.match(await page.locator("body").innerText(), value === "provisional" ? /Provisional/ : /Frozen/);
        assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
      }
    });
    await t.test("dark/light desktop/tablet/mobile keep long identities in bounds", async () => {
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["dark", "light"]) {
          if (theme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
          else await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width}px overflow`);
          assert.equal(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pc-token-panel")]
            .every((element) => element.scrollWidth <= element.clientWidth)), true, `${theme} ${width}px panel overflow`);
          assert.equal(await page.evaluate(() => {
            const expected = getComputedStyle(document.querySelector('.pc-token-sidebar-header h2')!).color;
            return [...document.querySelectorAll('.pc-token-list-item [class*="assetAmount"]')]
              .every((element) => getComputedStyle(element).color === expected);
          }), true, `${theme} ${width}px sidebar labels and balances must use theme text color`);
          await screenshot(`studio-${theme}-${width}`);
        }
      }
    });
    await t.test("concurrent refresh accepts only newest result; older provisional response cannot replace it", async () => {
      const before = (await stats()).reads;
      await page.evaluate(() => { window.portfolioQA.defer(true); window.portfolioQA.phase("provisional"); window.portfolioQA.refresh(); });
      await page.evaluate(() => { window.portfolioQA.phase("live"); window.portfolioQA.refresh(); });
      assert.equal((await stats()).reads, before + 2);
      await page.evaluate(() => window.portfolioQA.releaseOne(1));
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      assert.match(await page.getByRole("region", { name: "Selected token details" }).innerText(), /Authoritative account observation/);
      const current = await page.getByRole("region", { name: "Selected token details" }).innerText();
      await page.evaluate(() => window.portfolioQA.releaseOne(0));
      assert.equal(await page.getByRole("region", { name: "Selected token details" }).innerText(), current);
      await page.evaluate(() => window.portfolioQA.defer(false));
    });
    await t.test("network identity change hides old assets before delayed reads and restores only matching cache", async () => {
      await page.getByLabel("Amount", { exact: true }).fill("1");
      await page.evaluate(() => { window.portfolioQA.defer(true); window.portfolioQA.network(true); });
      await page.waitForFunction("!document.querySelector('[aria-label=\"Selected token details\"]')");
      assert.equal(await page.locator(".pc-token-list-item").count(), 0);
      await page.evaluate(() => { window.portfolioQA.network(false); window.portfolioQA.defer(false); window.portfolioQA.release(); });
      await page.waitForFunction("document.querySelector('[aria-label=\"Selected token details\"]')");
      assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "");
      // Default selection may be a controlled mint; the old selection must not
      // survive, and recovered holdings must belong to the restored network.
      assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.mint));
    });
    await t.test("wallet switch during a delayed read cannot publish the old wallet's response", async () => {
      await page.evaluate(() => { window.portfolioQA.defer(true); window.portfolioQA.refresh(); });
      await page.evaluate(() => window.portfolioQA.wallet("b"));
      await page.waitForFunction(`!document.body.textContent.includes('${ids.mint}')`);
      await page.evaluate(() => window.portfolioQA.releaseOne(1));
      await page.waitForFunction(`document.body.textContent.includes('${ids.walletBMint}')`);
      await page.evaluate(() => window.portfolioQA.releaseOne(0));
      assert.doesNotMatch(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.mint));
      await page.evaluate(() => { window.portfolioQA.defer(false); window.portfolioQA.wallet("a"); });
      await page.waitForFunction(`document.body.textContent.includes('${ids.mint}')`);
    });
    await t.test("exhausted/unavailable coverage never claims all holdings or deletes retained assets", async () => {
      await page.evaluate(() => window.portfolioQA.phase("exhausted"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("document.body.textContent.includes('cursor is exhausted')");
      assert.match(await page.locator("body").innerText(), /complete wallet holdings are not guaranteed/);
      assert.equal(await page.getByRole("button", { name: "Continue discovery" }).count(), 0);
      await page.evaluate(() => window.portfolioQA.phase("unavailable"));
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.waitForFunction("document.body.textContent.includes('Live discovery is unavailable')");
      assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.mint));
      assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), /Cached public observation/);
    });
    await t.test("Dashboard and popover remain bounded in both themes at desktop/tablet/narrow widths", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: /Dashboard$/ }).click();
      await page.evaluate(() => window.portfolioQA.balance("18446744073709551615"));
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["dark", "light"]) {
          if (theme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
          else await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} Dashboard ${width}px overflow`);
          assert.equal(await page.evaluate(() => {
            const balance = document.querySelector('[class*="balanceAmount"]')!;
            const bounds = balance.closest('[class*="heroPanel"]')!.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(balance);
            return [...range.getClientRects()].every((rect) => rect.left >= bounds.left && rect.right <= bounds.right);
          }), true, `${theme} ${width}px exact uint64 balance must not be clipped by hero`);
          await screenshot(`dashboard-${theme}-${width}`);
          await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
          assert.equal(await page.evaluate(() => {
            const dialog = document.querySelector<HTMLElement>('[aria-label="Wallet actions"][role="dialog"]')!;
            return dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().right <= innerWidth;
          }), true, `${theme} popover ${width}px overflow`);
          await screenshot(`popover-${theme}-${width}`);
          await page.getByRole("dialog", { name: "Wallet actions" }).press("Escape");
        }
      }
    });
    await t.test("unmount cancels delayed reads; no RPC, secret access or writes occurred", async () => {
      await page.evaluate(() => { window.portfolioQA.defer(true); });
      await page.getByRole("button", { name: "Refresh discovery" }).click();
      await page.evaluate(() => { window.portfolioQA.unmount(); window.portfolioQA.release(); });
      await page.waitForFunction("document.getElementById('root').childElementCount === 0");
      assert.equal((await stats()).writes, 0); assert.equal((await stats()).secretReads, 0);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(consoleProblems, []);
      assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0);
      t.diagnostic(`Final mocked boundary counts: ${JSON.stringify(await stats())}; network requests outside isolated origin=${unexpected.length}; browser errors/warnings=${errors.length + consoleProblems.length}`);
    });
  } finally { await browser.close(); }
});

// Referencing the fixture type also verifies the test browser's public control surface.
export type PortfolioBrowserControls = PortfolioQA;
