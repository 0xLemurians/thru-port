import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { build } from "esbuild";
import type { DiscoveryScenario } from "./fixtures/phase5b-discovery-harness";

interface Locator {
  click(): Promise<void>; fill(value: string): Promise<void>; selectOption(value: string): Promise<void>;
  press(value: string): Promise<void>; count(): Promise<number>; inputValue(): Promise<string>;
  innerText(): Promise<string>; isDisabled(): Promise<boolean>; first(): Locator; nth(n: number): Locator;
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(name: string, options?: { exact?: boolean }): Locator;
}
interface Page {
  goto(url: string): Promise<unknown>; reload(): Promise<unknown>; close(): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>; addStyleTag(options: { content: string }): Promise<unknown>;
  addInitScript(options: { content: string }): Promise<void>;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>; waitForFunction(expression: string): Promise<unknown>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(name: string, options?: { exact?: boolean }): Locator; locator(selector: string): Locator;
  setDefaultTimeout(ms: number): void;
  on(event: "pageerror", callback: (error: Error) => void): void;
  on(event: "console", callback: (message: { type(): string; text(): string }) => void): void;
}
interface Context {
  cookies(): Promise<unknown[]>; newPage(): Promise<Page>; close(): Promise<void>;
  route(pattern: string, cb: (route: { request(): { url(): string }; abort(): Promise<void>;
    fulfill(options: { status: number; contentType: string; body: string }): Promise<void> }) => Promise<void>): Promise<void>;
}
interface Runtime { chromium: { executablePath(): string; launchPersistentContext(profile: string, options: {
  headless: boolean; executablePath: string; serviceWorkers: "block"; args: string[];
}): Promise<Context> } }

// Process-local only: the runner may use pipes/loopback to its disposable browser,
// but neither node HTTP/fetch nor raw TCP may reach an external host.
function denyRunnerExternalTraffic() {
  const denied: string[] = [];
  const local = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
  const check = (input: unknown, fallback?: unknown) => {
    let host = "localhost";
    if (input instanceof URL) host = input.hostname;
    else if (typeof input === "string" && /^https?:\/\//.test(input)) host = new URL(input).hostname;
    else if (typeof input === "object" && input !== null) {
      const config = input as { hostname?: string; host?: string; url?: string };
      host = config.hostname ?? config.host ?? (config.url ? new URL(config.url).hostname : host);
    } else if (typeof input === "number" && typeof fallback === "string") host = fallback;
    if (!local(host)) { denied.push(host); throw new Error("Phase 5B runner denied non-local egress"); }
  };
  const fetch = globalThis.fetch, request = http.request, get = http.get, secureRequest = https.request, secureGet = https.get;
  const connect = net.Socket.prototype.connect;
  globalThis.fetch = ((input, init) => { check(input); return fetch(input, init); }) as typeof fetch;
  http.request = ((...args: unknown[]) => { check(args[0]); return Reflect.apply(request, http, args); }) as typeof request;
  http.get = ((...args: unknown[]) => { check(args[0]); return Reflect.apply(get, http, args); }) as typeof get;
  https.request = ((...args: unknown[]) => { check(args[0]); return Reflect.apply(secureRequest, https, args); }) as typeof secureRequest;
  https.get = ((...args: unknown[]) => { check(args[0]); return Reflect.apply(secureGet, https, args); }) as typeof secureGet;
  net.Socket.prototype.connect = (function (this: net.Socket, ...args: unknown[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    check(normalized[0], normalized[1]); return Reflect.apply(connect, this, args);
  }) as typeof connect;
  return { denied, restore() { globalThis.fetch = fetch; http.request = request; http.get = get;
    https.request = secureRequest; https.get = secureGet; net.Socket.prototype.connect = connect; } };
}

test("Phase 5B actual AppFlow, discovery, shared portfolio and IndexedDB in isolated Chromium", { timeout: 120_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const runtimePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  assert.ok(existsSync(runtimePath), "Existing Playwright is required; this QA never downloads tooling or skips silently");
  const guard = denyRunnerExternalTraffic();
  const profile = mkdtempSync(path.join(tmpdir(), "thru-port-phase5b-discovery-"));
  const workspace = realpathSync(process.cwd());
  assert.ok(!realpathSync(profile).toLowerCase().startsWith(workspace.toLowerCase() + path.sep), "Browser profile must stay outside repository");
  let context: Context | null = null;
  try {
    const runtime = require(runtimePath) as Runtime;
    const executablePath = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
    assert.ok(executablePath, "An installed Chromium is required; no browser install is permitted");
    const sdkPath = path.join(path.dirname(require.resolve("@thru/sdk")), "sdk.js").replaceAll("\\", "/");
    const fixture = path.resolve("tests/fixtures/phase5b-discovery-harness.tsx");
    const bundle = await build({ entryPoints: [fixture], write: false, bundle: true, platform: "browser", format: "iife",
      outdir: "unused-phase5b-output", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "phase5b-sdk-transport-only", setup(api) {
        api.onResolve({ filter: /^@thru\/sdk$/ }, () => ({ path: "sdk", namespace: "phase5b-sdk" }));
        api.onLoad({ filter: /.*/, namespace: "phase5b-sdk" }, () => ({ loader: "js", resolveDir: process.cwd(), contents: `
          export * from ${JSON.stringify(sdkPath)};
          import {createThruClient as actualCreate,Transaction} from ${JSON.stringify(sdkPath)};
          const boundary=()=>window.phase5bTransport;
          const forbid=()=>boundary().deny();
          Transaction.prototype.sign=forbid;
          Transaction.prototype.legacySign=forbid;
          export function createThruClient(config){
            const original=actualCreate(config);
            const call=(name,...args)=>{boundary().url(config.baseUrl);return boundary()[name](...args)};
            return {...original,
              keys:{...original.keys,generateKeyPair:forbid,fromPrivateKey:(...args)=>{boundary().derive();return original.keys.fromPrivateKey(...args)}},
              accounts:{get:(address)=>call('get',address,config.callOptions?.signal),list:(options)=>call('list',options,config.callOptions?.signal),create:forbid},
              transactions:{listForAccount:(...args)=>call('history',...args),send:forbid,sendAndTrack:forbid,get:forbid,getStatus:forbid},
              blocks:{getBlockHeight:()=>call('height'),get:forbid},chain:{getChainId:forbid},
              proofs:new Proxy({}, {get:()=>forbid})};
          }` }));
      } }] });
    const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
    const css = [readFileSync("app/globals.css", "utf8"), ...bundle.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text)].join("\n");
    context = await runtime.chromium.launchPersistentContext(profile, { headless: true, executablePath,
      serviceWorkers: "block", args: ["--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--disable-component-update",
        "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    assert.deepEqual(await context.cookies(), [], "Disposable profile must begin with zero cookies");
    const allowed = new Set<string>(), unexpected: string[] = [], errors: string[] = [], logs: string[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (allowed.has(url)) await route.fulfill({ status: 200, contentType: "text/html", body:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
      else { unexpected.push(new URL(url).hostname); await route.abort(); }
    });
    let originNumber = 0;
    async function createPage(scenario: DiscoveryScenario = "rich", native: string | null = "0") {
      const page = await context!.newPage(); page.setDefaultTimeout(6_000);
      page.on("pageerror", () => errors.push("redacted-browser-exception"));
      page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") logs.push(`redacted-browser-${message.type()}`); });
      // Raw init source avoids tsx's Node-only function-name instrumentation
      // being serialized into the browser by Playwright.
      await page.addInitScript({ content: `
        const deny=()=>{throw new Error('Phase 5B blocks browser network escape hatches')};
        window.WebSocket=deny;window.EventSource=deny;window.RTCPeerConnection=deny;navigator.sendBeacon=deny;
      ` });
      const origin = `http://127.0.0.1:${41_000 + (++originNumber)}/`; allowed.add(origin);
      await page.goto(origin);
      assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
        databases: (await indexedDB.databases()).length, secure: isSecureContext })),
      { local: 0, session: 0, databases: 0, secure: true }, "New origin must have no wallet or browser storage before fixture seeding");
      const configure = `window.phase5bDiscoveryConfig=${JSON.stringify({ scenario, native })};`;
      await page.addStyleTag({ content: css }); await page.addScriptTag({ content: configure + script });
      await page.waitForFunction("window.phase5bDiscoveryReady && document.body.textContent.includes('Saved References')");
      await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
      return { page, origin, configure };
    }
    const counts = (page: Page) => page.evaluate(() => window.phase5bDiscovery.stats());
    const refresh = async (page: Page) => {
      const before = (await counts(page)).inventory;
      await page.getByRole("button", { name: "Refresh discovery", exact: true }).click();
      await page.waitForFunction(`window.phase5bDiscovery.stats().inventory > ${before} && !document.body.textContent.includes('Discovering token accounts')`);
    };

    await t.test("actual inventory decodes received/custom/multi-source holdings independently of empty history", async () => {
      const { page } = await createPage();
      try {
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids);
        const initial = await counts(page);
        assert.equal(initial.inventory, 2); assert.deepEqual(initial.inventoryTokens, [null, "phase5b-page-2"]);
        assert.deepEqual(initial.inventoryPageSizes, [32, 32]); assert.equal(initial.creatorHistory, 1); assert.equal(initial.activityHistory, 1);
        assert.equal(initial.inventoryFiltersValid, true); assert.equal(initial.apiUrlsValid, true); assert.equal(initial.forbidden, 0);
        const holdings = page.getByRole("region", { name: "My Holdings" });
        assert.match(await holdings.innerText(), new RegExp(ids.mint)); assert.match(await holdings.innerText(), new RegExp(ids.sameTickerMint));
        assert.match(await holdings.innerText(), /2 source accounts/);
        await holdings.locator("summary").first().click();
        assert.match(await holdings.innerText(), new RegExp(ids.custom)); assert.match(await holdings.innerText(), /Observed balance: 7[\s\S]*Observed balance: 9/);
        assert.doesNotMatch(await holdings.innerText(), /Observed balance: 16/);
        assert.doesNotMatch(await holdings.innerText(), new RegExp(ids.foreign));
        assert.match(await page.getByRole("region", { name: "Created / Controlled Tokens" }).innerText(), /Creator fixture[\s\S]*Authority fixture/);
        assert.match(await page.getByRole("region", { name: "Saved References" }).innerText(), /Saved fixture[\s\S]*Ownership not confirmed/);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /2 pages · 8 candidates · 2 unresolved reads/);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /not a guarantee/);
        const cache = await page.evaluate(() => window.phase5bDiscovery.cache());
        assert.equal(cache.pending, 2); assert.equal(cache.cursor, "phase5b-page-3"); assert.equal(cache.containsSecretFields, false);
        t.diagnostic(`Actual SDK-mock calls: inventory=${initial.inventory}, history=${initial.creatorHistory}, activity=${initial.activityHistory}, accountGets=${initial.accountGets}, nativeGets=${initial.nativeGets}; no submission/signing`);
      } finally { await page.close(); }
    });

    await t.test("Continue retries unresolved public candidates, resumes cursor and never repeats creator history", async () => {
      const { page } = await createPage();
      try {
        const before = await counts(page);
        await page.evaluate(() => window.phase5bDiscovery.recover());
        await page.getByRole("button", { name: "Continue discovery", exact: true }).click();
        await page.waitForFunction("document.body.textContent.includes('Scan complete for available RPC inventory')");
        const after = await counts(page);
        assert.equal(after.inventory, before.inventory + 1); assert.equal(after.creatorHistory, before.creatorHistory);
        assert.equal(after.inventoryTokens.at(-1), "phase5b-page-3");
        const cache = await page.evaluate(() => window.phase5bDiscovery.cache());
        assert.equal(cache.pending, 0); assert.equal(cache.cursor, null); assert.equal(cache.sourceCount, 7);
        assert.equal(await page.getByRole("button", { name: "Continue discovery", exact: true }).count(), 0);
        t.diagnostic(`Continue delta: inventory=${after.inventory - before.inventory}, creator-history=0, accountGets=${after.accountGets - before.accountGets}; cache sources=${cache.sourceCount}`);
      } finally { await page.close(); }
    });

    await t.test("reload restores encrypted wallet and cached cursor without restarting the first inventory page", async () => {
      const { page, configure } = await createPage();
      try {
        const beforeWallet = await page.evaluate(() => window.phase5bDiscovery.ids.wallet);
        await page.reload(); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: configure + script });
        await page.waitForFunction("window.phase5bDiscoveryReady && document.body.textContent.includes('Saved References') && !document.body.textContent.includes('Discovering token accounts')");
        const after = await counts(page);
        assert.equal(await page.evaluate(() => window.phase5bDiscovery.ids.wallet), beforeWallet);
        assert.deepEqual(after.inventoryTokens, ["phase5b-page-3"]); assert.equal(after.creatorHistory, 1);
        assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), /source accounts/);
        assert.doesNotMatch(await page.locator("body").innerText(), /Save your private key/);
        t.diagnostic(`Real reload: inventory cursor=${after.inventoryTokens[0]}, inventory=${after.inventory}, creator-history=${after.creatorHistory}; wallet public identity consistent`);
      } finally { await page.close(); }
    });

    await t.test("all actual AppFlow views share discovery; MAX selects one account and native gate stays closed", async () => {
      const { page } = await createPage("clean");
      try {
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids), before = await counts(page);
        await page.getByLabel("Asset", { exact: true }).selectOption(ids.mint);
        await page.getByLabel("Balance source · one token account").selectOption(ids.custom);
        await page.getByRole("button", { name: "MAX", exact: true }).click();
        assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "9");
        for (let i = 0; i < 2; i++) {
          await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
          assert.match(await page.getByRole("dialog", { name: "Wallet actions" }).innerText(), /My Holdings/);
          await page.getByRole("dialog").press("Escape");
        }
        await page.getByRole("button", { name: "Tokens", exact: false }).first().click();
        assert.match(await page.locator("body").innerText(), /My Tokens/);
        await page.getByRole("button", { name: "Dashboard", exact: false }).first().click();
        const after = await counts(page);
        assert.equal(after.inventory, before.inventory); assert.equal(after.creatorHistory, before.creatorHistory);
        assert.equal(after.derivations, before.derivations); assert.equal(after.forbidden, 0);
        t.diagnostic("Popover open/close x2 and Token Studio round trip: inventory delta=0, creator history delta=0, private-key derivation delta=0, signing/submission=0");
      } finally { await page.close(); }
    });

    await t.test("provisional included source is displayed but MAX excludes it from authoritative source selection", async () => {
      const { page } = await createPage();
      try {
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids);
        const holdings = page.getByRole("region", { name: "My Holdings" });
        await holdings.locator("summary").nth(1).click();
        assert.match(await holdings.innerText(), /Provisional — not finalized/);
        assert.match(await holdings.innerText(), /Not a Send candidate: provisional/);
        await page.getByLabel("Asset", { exact: true }).selectOption(ids.sameTickerMint);
        await page.getByRole("button", { name: "MAX", exact: true }).click();
        assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "3", "MAX uses authoritative account, not provisional + authoritative total");
        assert.equal((await counts(page)).forbidden, 0);
      } finally { await page.close(); }
    });

    await t.test("unknown token source is not zero while an actual zero source remains exactly zero", async () => {
      const { page: unknown } = await createPage("unknown-token");
      try {
        const controlled = unknown.getByRole("region", { name: "Created / Controlled Tokens" });
        await controlled.locator("summary").first().click();
        assert.match(await controlled.innerText(), /Observed balance: Unavailable/);
        assert.doesNotMatch(await controlled.innerText(), /Observed balance: 0(?:\s|$)/);
      } finally { await unknown.close(); }
      const { page: zero } = await createPage("zero-token");
      try {
        const holdings = zero.getByRole("region", { name: "My Holdings" });
        await holdings.locator("summary").first().click();
        assert.match(await holdings.innerText(), /Observed balance: 0/);
        const ids = await zero.evaluate(() => window.phase5bDiscovery.ids);
        await zero.getByLabel("Asset", { exact: true }).selectOption(ids.mint);
        await zero.getByRole("button", { name: "MAX", exact: true }).click();
        assert.equal(await zero.getByLabel("Amount", { exact: true }).inputValue(), "0");
        assert.equal((await counts(zero)).forbidden, 0);
      } finally { await zero.close(); }
    });

    await t.test("native gate rejects valid-looking Dashboard and Popover keyboard/form submission", async () => {
      const { page } = await createPage("clean", "10000");
      try {
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids), before = await counts(page);
        await page.getByLabel("Asset", { exact: true }).selectOption("native-units");
        await page.getByLabel("Recipient Thru address", { exact: true }).fill(ids.otherWallet);
        await page.getByLabel("Amount (integer native units)", { exact: true }).fill("10");
        assert.equal(await page.getByRole("button", { name: "Review Send", exact: true }).isDisabled(), true);
        await page.getByLabel("Amount (integer native units)", { exact: true }).press("Enter");
        await page.evaluate(() => document.querySelector<HTMLFormElement>('form[aria-label="Native transfer"]')!.requestSubmit());
        assert.match(await page.locator('form[aria-label="Native transfer"]').innerText(), /Native sending is not enabled yet/);
        await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Wallet actions" });
        await dialog.getByRole("button", { name: "Send", exact: true }).click();
        await dialog.getByLabel("Asset", { exact: true }).selectOption("native-units");
        await dialog.getByLabel("Recipient Thru address", { exact: true }).fill(ids.otherWallet);
        await dialog.getByLabel("Amount (integer native units)", { exact: true }).fill("10");
        assert.equal(await dialog.getByRole("button", { name: "Review Send", exact: true }).isDisabled(), true);
        await dialog.getByLabel("Amount (integer native units)", { exact: true }).press("Enter");
        await page.evaluate(() => document.querySelector<HTMLFormElement>('[role="dialog"] form[aria-label="Native transfer"]')!.requestSubmit());
        assert.equal((await counts(page)).forbidden, 0);
        assert.equal((await counts(page)).accountGets, before.accountGets, "Disabled native UI must not even start transfer preflight reads");
      } finally { await page.close(); }
    });

    await t.test("native unavailable, zero and uint64 remain exact through actual AppFlow observations", async () => {
      for (const value of [null, "0", "18446744073709551615"]) {
        const { page } = await createPage("clean", value);
        try {
          const expected = value === null ? "Unavailable" : `${value} native units`;
          assert.match(await page.locator('[aria-label="Native asset"]').innerText(), new RegExp(expected));
          await page.getByRole("button", { name: "Wallet actions", exact: true }).click();
          assert.match(await page.getByRole("dialog", { name: "Wallet actions" }).innerText(), new RegExp(expected));
          assert.equal((await counts(page)).forbidden, 0);
        } finally { await page.close(); }
      }
    });

    await t.test("rate limiting is bounded, classified safely and only explicit refresh starts another scan", async () => {
      const { page } = await createPage("rate-limit");
      try {
        const before = await counts(page);
        assert.equal(before.inventory, 1); assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /RPC inventory unavailable/);
        assert.doesNotMatch(await page.locator("body").innerText(), /Synthetic RPC transport details/);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
        assert.equal((await counts(page)).inventory, 1, "429 must not cause a hidden retry loop");
        await page.evaluate(() => window.phase5bDiscovery.scenario("clean")); await refresh(page);
        assert.equal((await counts(page)).inventory, 2); assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), /2 source accounts/);
      } finally { await page.close(); }
    });

    await t.test("actual four-second inventory timeout becomes unavailable without retry or hidden zero holdings claim", async () => {
      const { page } = await createPage("timeout");
      try {
        assert.equal((await counts(page)).inventory, 1);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /RPC inventory unavailable/);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /not a guarantee/);
        assert.equal((await counts(page)).forbidden, 0);
      } finally { await page.close(); }
    });

    await t.test("offline retains scoped public references and Degraded permits warned bounded reads", async () => {
      const { page } = await createPage("clean");
      try {
        const before = await counts(page);
        await page.evaluate(() => window.phase5bDiscovery.health("Offline"));
        await page.waitForFunction("document.body.textContent.includes('RPC unavailable · cached holdings only')");
        assert.equal((await counts(page)).inventory, before.inventory);
        assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), /Cached public observation/);
        assert.match(await page.getByRole("region", { name: "Saved References" }).innerText(), /Saved fixture/);
        assert.equal(await page.getByRole("button", { name: "Refresh discovery", exact: true }).isDisabled(), true);
        await page.evaluate(() => window.phase5bDiscovery.health("Degraded"));
        await page.waitForFunction(`window.phase5bDiscovery.stats().inventory === ${before.inventory + 1} && !document.body.textContent.includes('Discovering token accounts')`);
        assert.match(await page.locator("body").innerText(), /Degraded|unstable|unstable|responding/i);
        assert.equal((await counts(page)).forbidden, 0);
      } finally { await page.close(); }
    });

    await t.test("quota and denied public storage preserve live observations and expose safe persistence warnings", async () => {
      const { page } = await createPage("clean");
      try {
        const before = await page.evaluate(() => window.phase5bDiscovery.cache());
        await page.evaluate(() => window.phase5bDiscovery.storage("quota")); await refresh(page);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /could not save/);
        assert.equal((await page.evaluate(() => window.phase5bDiscovery.cache())).sourceCount, before.sourceCount);
        assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), /source accounts/);
        await page.evaluate(() => window.phase5bDiscovery.storage("denied")); await refresh(page);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /could not save|cache is unavailable/);
        assert.equal(await page.evaluate(() => localStorage.getItem("phase5b-unrelated")), "preserved");
        await page.evaluate(() => window.phase5bDiscovery.storage("normal"));
      } finally { await page.close(); }
    });

    await t.test("older account versions cannot overwrite cached current balances", async () => {
      const { page } = await createPage("clean");
      try {
        await page.evaluate(() => window.phase5bDiscovery.scenario("old-version")); await refresh(page);
        const holdings = page.getByRole("region", { name: "My Holdings" }); await holdings.locator("summary").first().click();
        assert.match(await holdings.innerText(), /Observed balance: 7/); assert.doesNotMatch(await holdings.innerText(), /Observed balance: 99/);
        assert.equal((await counts(page)).forbidden, 0);
      } finally { await page.close(); }
    });

    await t.test("foreign-network cache is rejected without mutating the preserved AlphaNet namespace", async () => {
      const { page } = await createPage("clean");
      try {
        await page.evaluate(() => { window.phase5bDiscovery.foreignCache(); window.phase5bDiscovery.scenario("rate-limit"); window.phase5bDiscovery.remount(); });
        await page.waitForFunction("document.body.textContent.includes('RPC inventory unavailable') && !document.body.textContent.includes('Discovering token accounts')");
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids);
        const holdings = page.getByRole("region", { name: "My Holdings" });
        assert.equal(await holdings.locator("summary").count(), 0, "The persistent group heading is allowed, but no foreign-scope source may appear");
        assert.doesNotMatch(await holdings.innerText(), new RegExp(ids.mint));
        assert.match(await page.getByRole("region", { name: "Saved References" }).innerText(), /Saved fixture/);
        assert.equal(await page.evaluate(() => window.phase5bDiscovery.foreignCachePreserved()), true);
        assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /cache is unavailable/);
        assert.equal((await counts(page)).forbidden, 0);
      } finally { await page.close(); }
    });

    await t.test("wrong Token Program and malformed mint bytes remain unresolved instead of trusted holdings", async () => {
      for (const scenario of ["wrong-program", "malformed-mint"] as const) {
        const { page } = await createPage(scenario);
        try {
          const ids = await page.evaluate(() => window.phase5bDiscovery.ids);
          const holdings = page.getByRole("region", { name: "My Holdings" });
          if (scenario === "wrong-program") {
            await holdings.locator("summary").first().click();
            assert.doesNotMatch(await holdings.innerText(), new RegExp(ids.first));
            assert.match(await holdings.innerText(), new RegExp(ids.custom));
          } else assert.doesNotMatch(await holdings.innerText(), new RegExp(ids.mint));
          assert.match(await page.locator('[aria-label="Token discovery"]').innerText(), /Partial scan/);
          assert.ok((await page.evaluate(() => window.phase5bDiscovery.cache())).pending > 0);
          assert.equal((await counts(page)).inventory, 1); assert.equal((await counts(page)).forbidden, 0);
        } finally { await page.close(); }
      }
    });

    await t.test("same-frame refresh and a pending slow response remain bounded with no hidden retry", async () => {
      const { page } = await createPage("clean");
      try {
        const before = await counts(page);
        await page.evaluate(() => {
          window.phase5bDiscovery.deferInventory();
          const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Refresh discovery")!;
          button.click(); button.click();
        });
        await page.waitForFunction(`window.phase5bDiscovery.stats().inventory > ${before.inventory}`);
        assert.equal(await page.getByRole("button", { name: "Refresh discovery", exact: true }).isDisabled(), true);
        await page.evaluate(() => window.phase5bDiscovery.releaseInventory());
        await page.waitForFunction("!document.body.textContent.includes('Discovering token accounts')");
        const after = await counts(page), delta = after.inventory - before.inventory;
        assert.ok(delta >= 1 && delta <= 2, "Two explicit same-frame read intents are bounded; no automatic scan loop");
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
        assert.equal((await counts(page)).inventory, after.inventory);
        assert.equal((await counts(page)).forbidden, 0);
        t.diagnostic(`Same-frame Refresh x2: actual inventory delta=${delta}, automatic retries=0`);
      } finally { await page.close(); }
    });

    await t.test("old-wallet response and unmounted discovery cannot overwrite a freshly restored fixture identity", async () => {
      const { page } = await createPage("clean");
      try {
        const before = await counts(page);
        await page.evaluate(() => window.phase5bDiscovery.deferInventory());
        await page.getByRole("button", { name: "Refresh discovery", exact: true }).click();
        await page.waitForFunction(`window.phase5bDiscovery.stats().inventory === ${before.inventory + 1}`);
        await page.evaluate(() => window.phase5bDiscovery.switchFixtureWallet());
        await page.waitForFunction("document.body.textContent.includes(window.phase5bDiscovery.ids.otherWallet) && !document.body.textContent.includes('Discovering token accounts')");
        await page.evaluate(() => window.phase5bDiscovery.releaseInventory());
        const ids = await page.evaluate(() => window.phase5bDiscovery.ids);
        assert.equal(await page.evaluate(() => document.body.innerText.includes(window.phase5bDiscovery.ids.otherWallet.slice(0, 10) + "..." + window.phase5bDiscovery.ids.otherWallet.slice(-8))), true,
          "Visible active Dashboard address must be wallet B, not merely the persisted fixture record");
        assert.equal(await page.evaluate(() => document.body.innerText.includes(window.phase5bDiscovery.ids.wallet.slice(0, 10) + "..." + window.phase5bDiscovery.ids.wallet.slice(-8))), false);
        assert.doesNotMatch(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.mint));
        assert.match(await page.getByRole("region", { name: "My Holdings" }).innerText(), new RegExp(ids.sameTickerMint));
        const after = await counts(page); assert.equal(after.inventory, before.inventory + 2);
        await page.evaluate(() => window.phase5bDiscovery.unmount());
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
        assert.equal((await counts(page)).inventory, after.inventory);
        assert.equal(await page.locator("#root > *").count(), 0);
        t.diagnostic(`Wallet A delayed refresh + real vault switch to B: inventory delta=${after.inventory - before.inventory}; aborted scoped requests=${after.abortedRequests}; post-unmount scans=0`);
      } finally { await page.close(); }
    });

    assert.deepEqual(unexpected, [], "Unexpected browser request is a test failure");
    assert.deepEqual(guard.denied, [], "Unexpected runner egress is a test failure");
    assert.deepEqual(errors, [], "Browser exceptions are not ignored"); assert.deepEqual(logs, [], "Browser errors/warnings are not ignored");
    t.diagnostic(`Isolation: ${originNumber} initially empty loopback origins; disposable Chromium profile; external browser requests=0; runner egress=0; real AppFlow/IndexedDB/discovery/hook/model/UI; SDK transport only mocked`);
  } finally {
    await context?.close(); guard.restore();
    const resolved = realpathSync(profile), temporaryRoot = realpathSync(tmpdir());
    assert.ok(resolved.toLowerCase().startsWith(temporaryRoot.toLowerCase() + path.sep));
    assert.ok(path.basename(resolved).startsWith("thru-port-phase5b-discovery-"));
    rmSync(resolved, { recursive: true, force: false });
  }
});
