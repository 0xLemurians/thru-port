import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { build } from "esbuild";
import { Pubkey, Signature } from "@thru/sdk";
import {
  LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY,
  PENDING_TOKEN_OPERATION_STORAGE_KEY,
  PendingOperationJournalError,
  canonicalTokenOperationKey,
  loadPendingTokenOperations,
  persistPendingTokenOperation,
  savePendingTokenOperations,
  type PendingTokenOperationRecord,
} from "../lib/token/pending-operation";
import { safeTokenActionError } from "../lib/token/network-state";
import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionUncertainError,
} from "../lib/thru/transactions";
import { NETWORK_RPC_UNAVAILABLE_MESSAGE } from "../lib/thru/name-service/constants";
import type { Phase5CSendQA } from "./fixtures/phase5c-token-send-harness";

interface Locator {
  click(): Promise<void>; fill(value: string): Promise<void>; selectOption(value: string): Promise<void>;
  press(value: string): Promise<void>; count(): Promise<number>; inputValue(): Promise<string>;
  innerText(): Promise<string>; isDisabled(): Promise<boolean>; first(): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(name: string | RegExp, options?: { exact?: boolean }): Locator;
  locator(selector: string): Locator;
}
interface Page {
  goto(url: string): Promise<unknown>; url(): string; reload(): Promise<unknown>; close(): Promise<void>;
  addInitScript(options: { content: string }): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>; addStyleTag(options: { content: string }): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<Awaited<T>>;
  waitForFunction(expression: string): Promise<unknown>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(name: string | RegExp, options?: { exact?: boolean }): Locator;
  locator(selector: string): Locator;
  on(event: string, callback: (value: { type(): string }) => void): void;
}
interface Route {
  request(): { url(): string };
  fulfill(options: { status: number; contentType: string; body: string }): Promise<void>;
  abort(): Promise<void>;
}
interface Context {
  cookies(): Promise<unknown[]>; newPage(): Promise<Page>; close(): Promise<void>;
  route(pattern: string, cb: (route: Route) => Promise<void>): Promise<void>;
}
interface Runtime { chromium: {
  executablePath(): string;
  launchPersistentContext(directory: string, options: {
    headless: boolean; executablePath: string; serviceWorkers: string; args: string[];
  }): Promise<Context>;
} }

type Surface = "dashboard" | "popover" | "studio";
type Configuration = Parameters<Phase5CSendQA["configure"]>[0];

function denyRunnerEgress() {
  const denied: string[] = [];
  const originalFetch = globalThis.fetch;
  const request = http.request, get = http.get, secureRequest = https.request, secureGet = https.get;
  const connect = net.Socket.prototype.connect;
  const blocked = () => { denied.push("blocked-runner-egress"); throw new Error("Phase 5C denies runner network traffic"); };
  globalThis.fetch = blocked;
  http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
  net.Socket.prototype.connect = (function (this: net.Socket, ...args: unknown[]) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const pipe = typeof input === "string" ? input : typeof input === "object" && input !== null && "path" in input
      ? (input as { path?: unknown }).path : null;
    if (typeof pipe === "string" && (pipe.startsWith("\\\\.\\pipe\\") || path.isAbsolute(pipe))) return Reflect.apply(connect, this, args);
    return blocked();
  }) as typeof connect;
  syncBuiltinESMExports();
  return { denied, restore() {
    globalThis.fetch = originalFetch; http.request = request; http.get = get;
    https.request = secureRequest; https.get = secureGet; net.Socket.prototype.connect = connect;
    syncBuiltinESMExports();
  } };
}

// Synthetic public identifiers only: no usable signing key or transaction.
const JOURNAL_NOW = 1_700_000_000_000;
const journalAddress = (marker: number) => Pubkey.from(new Uint8Array(32).fill(marker)).toThruFmt();
function journalRecord(): PendingTokenOperationRecord {
  const walletAddress = journalAddress(41), mintAddress = journalAddress(42);
  const sourceTokenAccount = journalAddress(43), destinationTokenAccount = journalAddress(44);
  const recipientAddress = journalAddress(45);
  return {
    schemaVersion: 1,
    key: canonicalTokenOperationKey({ operationType: "transfer", walletAddress, mintAddress,
      sourceTokenAccount, destinationTokenAccount, recipientAddress, amountRaw: 25n }),
    operationType: "transfer",
    signature: Signature.from(new Uint8Array(64).fill(46)).toThruFmt(),
    walletAddress, mintAddress, sourceTokenAccount, destinationTokenAccount, recipientAddress,
    amountRaw: "25", createdAt: JOURNAL_NOW, lastCheckedAt: JOURNAL_NOW, status: "submitted",
    expectedPreState: { mintSupply: "1000", sourceBalance: "100", destinationBalance: "10" },
    expectedPostState: { mintSupply: "1000", sourceBalance: "75", sourceOwner: walletAddress,
      destinationBalance: "35", destinationOwner: recipientAddress, destinationFrozen: false },
  };
}

test("Phase 5C-R: journal read-back validates canonical entries and preserves schema, scope and seven-day retention", () => {
  const values = new Map<string, string>();
  const record = journalRecord();
  const legacy = JSON.stringify([{ legacy: "public-placeholder" }]);
  values.set(LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY, legacy);
  let writes = 0, reads = 0;
  const storage = { getItem(key: string) { reads += 1; return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes += 1; values.set(key, value); } };
  savePendingTokenOperations(storage, [record], JOURNAL_NOW + 1);
  assert.equal(writes, 1); assert.equal(reads, 1, "write must be verified through the same storage boundary");
  assert.deepEqual(loadPendingTokenOperations(storage, JOURNAL_NOW + 1), [record]);
  assert.equal(values.get(LEGACY_ALPHANET_PENDING_TOKEN_OPERATION_STORAGE_KEY), legacy);
  assert.match(PENDING_TOKEN_OPERATION_STORAGE_KEY, /betanet:2/);
  assert.equal(loadPendingTokenOperations(storage, JOURNAL_NOW + 7 * 86_400_000).length, 1);
  assert.deepEqual(loadPendingTokenOperations(storage, JOURNAL_NOW + 7 * 86_400_000 + 1), []);
  savePendingTokenOperations(storage, [record], JOURNAL_NOW + 8 * 86_400_000);
  assert.equal(values.get(PENDING_TOKEN_OPERATION_STORAGE_KEY), "[]");
  savePendingTokenOperations(storage, [], JOURNAL_NOW + 8 * 86_400_000);
});

test("Phase 5C-R: journal persistence faults fail closed before the first intercepted send", async (t) => {
  const record = journalRecord();
  const otherSignature = Signature.from(new Uint8Array(64).fill(47)).toThruFmt();
  const faults: [string, (records: PendingTokenOperationRecord[]) => string | null][] = [
    ["silent setItem drop", () => null],
    ["stale old value", (records) => JSON.stringify(records.map((entry) => ({ ...entry, status: "uncertain" })))],
    ["missing intended record", () => "[]"],
    ["wrong signature", (records) => JSON.stringify(records.map((entry) => ({ ...entry, signature: otherSignature })))],
    ["wrong wallet", (records) => JSON.stringify(records.map((entry) => ({ ...entry, walletAddress: journalAddress(48) })))],
    ["wrong operation", (records) => JSON.stringify(records.map((entry) => ({ ...entry, operationType: "mint-additional" })))],
    ["wrong operation identity", (records) => JSON.stringify(records.map((entry) => ({ ...entry, key: `${entry.key}:changed` })))],
    ["wrong expected post-state", (records) => JSON.stringify(records.map((entry) => ({ ...entry, expectedPostState: { ...entry.expectedPostState, destinationBalance: "36" } })))],
    ["missing expected pre-state", (records) => JSON.stringify(records.map((entry) => ({ ...entry, expectedPreState: undefined })))],
    ["truncated records", (records) => JSON.stringify(records).slice(0, -3)],
    ["replaced record", (records) => JSON.stringify(records.map((entry) => ({ ...entry, mintAddress: journalAddress(49) })))],
    ["wrong network boundary", () => null],
  ];
  for (const [name, mutate] of faults) {
    await t.test(name, () => {
      let submitted = 0, stored: string | null = null;
      const storage = {
        setItem(key: string, value: string) {
          assert.equal(key, PENDING_TOKEN_OPERATION_STORAGE_KEY);
          stored = mutate(JSON.parse(value) as PendingTokenOperationRecord[]);
        },
        getItem(key: string) {
          assert.equal(key, PENDING_TOKEN_OPERATION_STORAGE_KEY);
          return stored;
        },
      };
      assert.throws(() => {
        savePendingTokenOperations(storage, [record], JOURNAL_NOW + 1);
        submitted += 1;
      }, PendingOperationJournalError);
      assert.equal(submitted, 0);
    });
  }
  for (const fault of ["quota", "read-back exception", "no read-back adapter"] as const) {
    await t.test(fault, () => {
      let submitted = 0;
      const storage = {
        setItem() { if (fault === "quota") throw new DOMException("synthetic", "QuotaExceededError"); },
        ...(fault === "no read-back adapter" ? {} : {
          getItem(): string | null { throw new DOMException("synthetic", "SecurityError"); },
        }),
      };
      assert.throws(() => {
        savePendingTokenOperations(storage, [record], JOURNAL_NOW + 1);
        submitted += 1;
      }, (error: unknown) => error instanceof PendingOperationJournalError && !error.message.includes("synthetic"));
      assert.equal(submitted, 0);
    });
  }
});

test("Phase 5C-R: the intended new entry cannot be silently pruned by the existing journal TTL", (t) => {
  t.mock.method(Date, "now", () => JOURNAL_NOW + 8 * 86_400_000);
  assert.throws(() => persistPendingTokenOperation(journalRecord()), PendingOperationJournalError);
});

test("Phase 5C-R: actual persistence retains its exact intended entry with a full newer-record catalog", (t) => {
  t.mock.method(Date, "now", () => JOURNAL_NOW + 100);
  const record = journalRecord();
  const newer = Array.from({ length: 32 }, (_, index) => ({ ...record,
    key: `${record.key}:newer-${index}`, createdAt: JOURNAL_NOW + index + 1,
    lastCheckedAt: JOURNAL_NOW + index + 1 }));
  let stored = JSON.stringify(newer);
  const storage = { getItem: () => stored, setItem(_key: string, value: string) { stored = value; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  persistPendingTokenOperation(record);
  const persisted = loadPendingTokenOperations(storage, JOURNAL_NOW + 100);
  assert.equal(persisted.length, 32);
  assert.deepEqual(persisted.find((entry) => entry.key === record.key), record);
  savePendingTokenOperations(storage, [], JOURNAL_NOW + 100);
  assert.equal(stored, "[]", "verified empty cleanup remains supported");
});

test("Phase 5C-R: typed and cached canonical uncertainty survive sanitization without trusting arbitrary diagnostics", () => {
  const uncertain = new SubmittedTransactionUncertainError(journalRecord().signature);
  uncertain.message = "rpc unavailable https://synthetic.invalid/internal";
  assert.equal(safeTokenActionError(uncertain, "Failed"), SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
  assert.equal(safeTokenActionError(SAFE_TRANSACTION_UNCERTAIN_MESSAGE, "Failed"), SAFE_TRANSACTION_UNCERTAIN_MESSAGE);
  for (const raw of ["service unavailable", "RPC unavailable https://synthetic.invalid/internal",
    `${SAFE_TRANSACTION_UNCERTAIN_MESSAGE} https://synthetic.invalid/internal`]) {
    assert.equal(safeTokenActionError(new Error(raw), "Failed"), NETWORK_RPC_UNAVAILABLE_MESSAGE);
  }
  assert.equal(safeTokenActionError(new Error("Amount exceeds the selected token account balance."), "Failed"),
    "Amount exceeds the selected token account balance.");
  assert.equal(safeTokenActionError(null, "Token transfer failed."), "Token transfer failed.");
});

test("Phase 5C: actual Send UI, hook, core, journal and same-origin Chromium locks with fake execution boundaries", { timeout: 120_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const runtimePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  assert.ok(existsSync(runtimePath), "Existing installed Playwright is required; no download or silent skip");
  const profile = mkdtempSync(path.join(tmpdir(), "thru-port-phase5c-send-"));
  assert.ok(!realpathSync(profile).toLowerCase().startsWith(realpathSync(process.cwd()).toLowerCase() + path.sep));
  const guard = denyRunnerEgress();
  let context: Context | undefined;
  try {
    const runtime = require(runtimePath) as Runtime;
    const executablePath = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
    assert.ok(executablePath, "Installed Chromium required; this QA never installs a browser");
    const fixture = path.resolve("tests/fixtures/phase5c-token-send-harness.tsx").replaceAll("\\", "/");
    const output = await build({ entryPoints: [fixture], bundle: true, write: false, outdir: "unused-phase5c-output",
      platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "phase5c-client-sensitive-boundary-only", setup(api) {
        api.onResolve({ filter: /(?:lib\/thru\/client|\.\/client|\.\.\/thru\/client)$/ }, (args) => {
          const full = args.path.startsWith("@/") ? path.resolve(args.path.slice(2)) : path.resolve(args.resolveDir, args.path);
          if (full.replaceAll("\\", "/").endsWith("/lib/thru/client")) return { path: full, namespace: "phase5c-client" };
        });
        api.onLoad({ filter: /.*/, namespace: "phase5c-client" }, () => ({ loader: "ts", resolveDir: process.cwd(), contents: `
          import {THRU_NETWORK} from ${JSON.stringify(path.resolve("lib/thru/network.ts").replaceAll("\\", "/"))};
          export const THRU_RPC_URL=THRU_NETWORK.rpcUrl;
          export const thru=new Proxy({}, {get:(_,key)=>window.phase5cTransport.client[key]});
          export function createThruAccountReader(){return window.phase5cTransport.client.accounts;}
        ` }));
      } }] });
    const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    assert.ok(script, "Browser harness must bundle into memory");
    const css = [readFileSync("app/globals.css", "utf8"), ...output.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text)].join("\n");
    context = await runtime.chromium.launchPersistentContext(profile, { headless: true, executablePath, serviceWorkers: "block",
      args: ["--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--disable-component-update",
        "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    assert.deepEqual(await context.cookies(), [], "Disposable profile starts with zero cookies");
    const allowed = new Set<string>(), unexpected: string[] = [], exceptions: number[] = [], consoleErrors: number[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (allowed.has(url)) await route.fulfill({ status: 200, contentType: "text/html", body:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
      else { unexpected.push(new URL(url).origin); await route.abort(); }
    });
    let originCount = 0;
    const totals = { build: 0, sign: 0, send: 0, status: 0, proof: 0, browserDenied: 0, sdkForbidden: 0,
      journalWrites: 0, journalReads: 0, journalReadBacks: 0, fenceWrites: 0, fenceReads: 0 };
    const observedDocuments = new Map<string, Record<string, number>>();
    const stats = (page: Page) => page.evaluate(() => window.phase5cSend.stats());
    const state = (page: Page) => page.evaluate(() => window.phase5cSend.publicState());
    const collect = async (page: Page) => {
      const observation = await page.evaluate(() => ({
        document: `${location.origin}:${performance.timeOrigin}`,
        stats: window.phase5cSend.stats(), state: window.phase5cSend.publicState(),
      }));
      const current = observation.stats;
      assert.equal(current.forbidden, 0, "SDK deny boundary must never be reached");
      assert.equal(await page.evaluate(() => Number(Reflect.get(window, "phase5cDeniedBrowserCalls")) || 0), 0,
        "A caught browser escape-hatch call is still an isolation failure");
      const measured = { build: current.build, sign: current.sign, send: current.send,
        status: current.getStatus, proof: current.proofs,
        journalWrites: observation.state.journalWrites, journalReads: observation.state.journalReads,
        journalReadBacks: observation.state.journalReadBacks,
        fenceWrites: observation.state.fenceWrites, fenceReads: observation.state.fenceReads };
      const previous = observedDocuments.get(observation.document);
      for (const key of Object.keys(measured) as (keyof typeof measured)[]) {
        totals[key] += measured[key] - (previous?.[key] ?? 0);
      }
      observedDocuments.set(observation.document, measured);
    };
    async function install(page: Page) {
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: script! });
      await page.waitForFunction("document.querySelector('#phase5c-observation')?.getAttribute('data-ready') === 'true'");
    }
    async function createPage(options: { origin?: string; surface?: Surface; config?: Configuration } = {}) {
      const page = await context!.newPage(); page.setDefaultTimeout(5_000);
      const close = page.close.bind(page);
      page.close = async () => {
        try {
          // Failed assertions still contribute evidence; repeated collection is
          // delta-based, and a reload has a distinct document identity.
          await collect(page);
          const blocked = await page.evaluate(() => ({
            browser: Number(Reflect.get(window, "phase5cDeniedBrowserCalls")) || 0,
            sdk: window.phase5cSend?.stats().forbidden ?? 0,
          }));
          totals.browserDenied += blocked.browser; totals.sdkForbidden += blocked.sdk;
          assert.deepEqual(blocked, { browser: 0, sdk: 0 }, "Every page, including a failed scenario, must prove no hidden boundary attempts");
        } finally { await close(); }
      };
      page.on("pageerror", () => exceptions.push(1));
      page.on("console", (entry) => { if (["error", "warning"].includes(entry.type())) consoleErrors.push(1); });
      await page.addInitScript({ content: `
        window.phase5cDeniedBrowserCalls=0;
        const deny=()=>{window.phase5cDeniedBrowserCalls++;throw new Error('Phase 5C blocks browser external execution')};
        window.fetch=deny;window.WebSocket=deny;window.EventSource=deny;window.RTCPeerConnection=deny;navigator.sendBeacon=deny;
      ` });
      const origin = options.origin ?? `http://127.0.0.1:${45_000 + (++originCount)}/`;
      allowed.add(origin); await page.goto(origin); assert.equal(page.url(), origin);
      assert.equal(await page.evaluate(() => isSecureContext && !!navigator.locks), true, "Secure same-origin Chromium Web Locks required");
      if (!options.origin) assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
        databases: (await indexedDB.databases()).length })), { local: 0, session: 0, databases: 0 });
      await install(page);
      if (options.config) await page.evaluate((config) => window.phase5cSend.configure(config), options.config);
      await surface(page, options.surface ?? "dashboard");
      return { page, origin };
    }
    async function surface(page: Page, value: Surface) {
      await page.evaluate((selected) => window.phase5cSend.surface(selected), value);
      await page.waitForFunction(`document.querySelector('[data-phase5c-surface="${value}"]') !== null`);
      if (value === "popover") await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    function sendButton(page: Page, value: Surface) {
      return page.getByRole("button", { name: value === "dashboard" ? "Review Send" : value === "popover" ? "Send Token" : "Send", exact: true });
    }
    async function fillTransfer(page: Page, value: Surface, amount = "1") {
      const ids = await page.evaluate(() => window.phase5cSend.ids);
      const asset = page.getByRole("combobox", { name: "Asset", exact: true });
      if (await asset.count()) await asset.selectOption(ids.mint);
      const source = page.getByRole("combobox", { name: "Balance source · one token account", exact: true });
      if (await source.count()) await source.selectOption(ids.sourceA);
      await page.getByLabel(value === "dashboard" ? "Recipient" : "Recipient THRU address", { exact: true }).fill(ids.recipient);
      await page.getByLabel("Amount", { exact: true }).fill(amount);
      return ids;
    }

    for (const currentSurface of ["dashboard", "popover", "studio"] as const) await t.test(`real ${currentSurface} Send UI reaches the actual hook/core and one intercepted unary submission`, async () => {
      const { page } = await createPage({ surface: currentSurface });
      try {
        await fillTransfer(page, currentSurface);
        const before = await stats(page);
        assert.equal(before.sign, 0); assert.equal(before.send, 0);
        await sendButton(page, currentSurface).click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && /Success!|Transfer successful!/.test(document.body.textContent)");
        const result = await stats(page), publicState = await state(page);
        assert.equal(result.build, 1); assert.equal(result.sign, 1); assert.equal(result.send, 1);
        assert.ok(result.getStatus >= 1); assert.deepEqual(result.sendTypes, ["transfer"]);
        assert.deepEqual(result.durabilityAtSend, [{ journal: true, fence: true }]);
        assert.equal(result.forbidden, 0); assert.equal(publicState.journalCount, 0); assert.equal(publicState.fenceCount, 0);
        assert.equal(publicState.refreshCalls, 1); assert.equal(publicState.containsSensitiveFields, false);
        assert.equal(publicState.nativeGate, false);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("Dashboard MAX uses the selected account rather than the sum of same-mint balances", async () => {
      const { page } = await createPage();
      try {
        const ids = await fillTransfer(page, "dashboard");
        await page.getByRole("button", { name: "MAX", exact: true }).click();
        assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "1.25");
        await page.getByRole("combobox", { name: "Balance source · one token account", exact: true }).selectOption(ids.sourceB);
        await page.getByRole("button", { name: "MAX", exact: true }).click();
        assert.equal(await page.getByLabel("Amount", { exact: true }).inputValue(), "3.5");
        assert.equal((await stats(page)).sign, 0); assert.equal((await stats(page)).send, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("invalid decimal, zero, negative, scientific and excessive selected-source amounts never reach signing", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard");
        for (const invalid of ["0", "-1", "1.255", "1e2", "1.26", "18446744073709551616"]) {
          await page.getByLabel("Amount", { exact: true }).fill(invalid);
          assert.equal(await sendButton(page, "dashboard").isDisabled(), true, `invalid amount class must disable submission`);
        }
        assert.equal((await stats(page)).build, 0); assert.equal((await stats(page)).sign, 0); assert.equal((await stats(page)).send, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("invalid recipient is rejected through the actual destination preparation without signing", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard");
        await page.getByLabel("Recipient", { exact: true }).fill("invalid-public-test-address");
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("document.body.textContent.includes('not a valid Thru address')");
        assert.equal((await stats(page)).build, 0); assert.equal((await stats(page)).sign, 0); assert.equal((await stats(page)).send, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    for (const violation of ["wrong-owner", "wrong-program", "wrong-mint", "wrong-address", "frozen", "missing"] as const) await t.test(`fresh ${violation} source evidence cannot sign or silently substitute a different same-mint account`, async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard");
        const before = await stats(page);
        await page.evaluate((value) => window.phase5cSend.configure({ sourceViolation: value }), violation);
        await sendButton(page, "dashboard").click();
        await page.waitForFunction(`window.phase5cSend.stats().accountGets > ${before.accountGets} && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')`);
        const result = await stats(page);
        assert.equal(result.sign, 0); assert.equal(result.send, 0); assert.deepEqual(result.sendTypes, []);
        assert.doesNotMatch(await page.locator("body").innerText(), /Success!|Transfer successful!/);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("a source balance decreased after UI observation is re-read before signing", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard", "1");
        const before = await stats(page);
        await page.evaluate(() => window.phase5cSend.configure({ sourceRaw: "50" }));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction(`window.phase5cSend.stats().accountGets > ${before.accountGets} && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')`);
        assert.equal((await stats(page)).sign, 0); assert.equal((await stats(page)).send, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("unmount during a held pre-submission build aborts before fake signing or sending", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.hold("build"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().build === 1");
        await page.evaluate(() => { window.phase5cSend.unmount(); window.phase5cSend.release("build"); });
        await page.waitForFunction("window.phase5cSend.stats().events.includes('build:complete')");
        assert.equal((await stats(page)).sign, 0); assert.equal((await stats(page)).send, 0);
        assert.equal((await state(page)).journalCount, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("wallet A replaced by B during pre-submission work must not sign or submit A later", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.hold("build"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().build === 1");
        await page.evaluate(() => window.phase5cSend.wallet("b"));
        await page.waitForFunction("window.phase5cSend.publicState().wallet === 'b' && window.phase5cSend.publicState().ready");
        await page.evaluate(() => window.phase5cSend.release("build"));
        await page.waitForFunction("window.phase5cSend.stats().events.includes('build:complete')");
        const result = await stats(page);
        await collect(page);
        assert.equal(result.sign, 0, "a wallet identity change must invalidate the old unsent signing intent");
        assert.equal(result.send, 0);
      } finally { await page.close(); }
    });

    await t.test("unsupported Web Locks exposes only the existing token compatibility path, not guaranteed cross-tab exclusion", async () => {
      const { page } = await createPage();
      try {
        await page.evaluate(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
        await fillTransfer(page, "dashboard"); await sendButton(page, "dashboard").click();
        await page.waitForFunction("document.body.textContent.includes('Success!')");
        const result = await stats(page);
        assert.equal(result.send, 1); assert.equal(result.sign, 1);
        assert.deepEqual(result.durabilityAtSend, [{ journal: true, fence: false }]);
        assert.equal((await state(page)).nativeGate, false);
        await collect(page);
        t.diagnostic("Observed token-only legacy compatibility: no Web Lock and no guarded write fence; this is not evidence of cross-tab protection.");
      } finally { await page.close(); }
    });

    await t.test("unmount after submission continues only verification and never sends the operation again", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.hold("status"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.stats().getStatus >= 1");
        assert.equal((await state(page)).journalCount, 1); assert.equal((await state(page)).fenceCount, 1);
        await page.evaluate(() => window.phase5cSend.unmount());
        const beforeVerification = await stats(page);
        await page.evaluate(() => window.phase5cSend.release("status"));
        await page.waitForFunction("window.phase5cSend.publicState().journalCount === 0 && window.phase5cSend.publicState().fenceCount === 0");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        assert.equal((await stats(page)).send, 1); assert.equal((await stats(page)).sign, 1);
        assert.equal(await page.locator("#root > *").count(), 0);
        await collect(page);
        assert.equal((await stats(page)).inventory, beforeVerification.inventory,
          "late transfer completion must not restart discovery after its shared portfolio owner unmounts");
        assert.equal((await stats(page)).history, beforeVerification.history);
      } finally { await page.close(); }
    });

    await t.test("late submitted wallet A success must not become visible success in active wallet B", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.hold("status"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.stats().getStatus >= 1");
        await page.evaluate(() => window.phase5cSend.wallet("b"));
        await page.waitForFunction("window.phase5cSend.publicState().wallet === 'b' && window.phase5cSend.publicState().ready");
        await page.evaluate(() => window.phase5cSend.release("status"));
        await page.waitForFunction("window.phase5cSend.publicState().journalCount === 0 && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')");
        assert.equal((await stats(page)).send, 1); assert.equal((await state(page)).wallet, "b");
        await collect(page);
        assert.equal(/Success!|Transfer successful!/.test(await page.locator("body").innerText()), false,
          "an old wallet result must not be presented as the currently active wallet's successful transfer");
      } finally { await page.close(); }
    });

    await t.test("cleanup failure after verified execution retains the fence and journal without inviting a retry", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.storageFault("cleanup"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("document.body.textContent.includes('Success!')");
        assert.equal((await stats(page)).send, 1); assert.equal((await state(page)).journalCount, 1); assert.equal((await state(page)).fenceCount, 1);
        // The refreshed selected-source balance is now 0.25, so the original
        // amount is disabled even before guard checks. A valid new 0.1 intent
        // must still be blocked by the unresolved cleanup fence.
        await page.getByLabel("Amount", { exact: true }).fill("0.1");
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("document.body.textContent.includes('Another write is active or still awaiting verification')");
        assert.equal((await stats(page)).send, 1); assert.equal((await stats(page)).sign, 1);
        await page.evaluate(() => window.phase5cSend.storageFault("normal"));
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("missing destination initializes exactly once before one transfer, with separate durable signatures", async () => {
      const { page } = await createPage({ config: { mode: "missingdest" } });
      try {
        await fillTransfer(page, "dashboard");
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 2 && document.body.textContent.includes('Success!')");
        const result = await stats(page), publicState = await state(page);
        assert.equal(result.build, 2); assert.equal(result.sign, 2); assert.equal(result.send, 2);
        assert.deepEqual(result.sendTypes, ["initialize-account", "transfer"]);
        assert.deepEqual(result.durabilityAtSend, [{ journal: true, fence: true }, { journal: true, fence: true }]);
        assert.equal(publicState.journalCount, 0); assert.equal(publicState.fenceCount, 0); assert.equal(publicState.refreshCalls, 1);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("three temporary not_found statuses continue read-only polling before one successful transfer", async () => {
      const { page } = await createPage({ config: { mode: "transientnotfound", statusNotFoundCount: 3 } });
      try {
        await fillTransfer(page, "dashboard"); await sendButton(page, "dashboard").click();
        // Observe the third visibility delay before its next scheduled poll;
        // each Playwright wait retains the existing 5-second harness limit.
        await page.waitForFunction("window.phase5cSend.stats().getStatus >= 2");
        await page.waitForFunction("window.phase5cSend.stats().getStatus >= 3");
        assert.equal((await stats(page)).send, 1); assert.equal((await stats(page)).sign, 1);
        await page.waitForFunction("document.body.textContent.includes('Success!')");
        assert.equal((await stats(page)).send, 1); assert.equal((await stats(page)).getStatus, 4);
        assert.equal((await state(page)).journalCount, 0); await collect(page);
      } finally { await page.close(); }
    });

    await t.test("uncertain destination initialization cannot automatically proceed to transfer or repeat initialization", async () => {
      const { page } = await createPage({ config: { mode: "sendlost", destinationExists: false } });
      try {
        await fillTransfer(page, "dashboard"); await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')");
        const result = await stats(page);
        assert.deepEqual(result.sendTypes, ["initialize-account"]); assert.equal(result.send, 1); assert.equal(result.sign, 1);
        assert.equal(result.getStatus, 0); assert.equal((await state(page)).journalCount, 1); assert.equal((await state(page)).fenceCount, 1);
        assert.equal((await state(page)).refreshCalls, 0);
        assert.equal((await page.evaluate(() => window.phase5cSend.snapshot())).destinationExists, false);
        assert.doesNotMatch(await page.locator("body").innerText(), /Success!|Transfer successful!/);
        await collect(page);
      } finally { await page.close(); }
    });

    for (const fault of ["journal-write", "quota", "denied", "fence-write"] as const) await t.test(`${fault} storage failure stops the real token path before unary send`, async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard");
        await page.evaluate((value) => window.phase5cSend.storageFault(value), fault);
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("!document.body.textContent.includes('Confirming token transfer...') && /unavailable|awaiting verification|Token transfer failed|pending-operation|Synthetic storage denied/.test(document.body.textContent)");
        assert.equal((await stats(page)).send, 0);
        await page.evaluate(() => window.phase5cSend.storageFault("normal"));
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("silent journal write/read-back failure must prevent submission even when the write fence persists", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard");
        await page.evaluate(() => window.phase5cSend.storageFault("journal-readback"));
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send > 0 || /pending-operation|unavailable|awaiting verification|Token transfer failed/.test(document.body.textContent)");
        const result = await stats(page);
        await page.evaluate(() => window.phase5cSend.storageFault("normal"));
        await collect(page);
        assert.equal(result.send, 0, "required journal persistence must be read-back verified before unary submission");
      } finally { await page.close(); }
    });

    await t.test("signature mismatch remains uncertain with the exact public journal signature and no automatic second send", async () => {
      const { page } = await createPage({ config: { mode: "signaturemismatch" } });
      try {
        await fillTransfer(page, "dashboard");
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')");
        const result = await stats(page), publicState = await state(page);
        assert.equal(result.send, 1); assert.equal(result.sign, 1); assert.equal(result.getStatus, 0);
        assert.equal(publicState.journalCount, 1); assert.equal(publicState.fenceCount, 1); assert.equal(publicState.refreshCalls, 0);
        assert.doesNotMatch(await page.locator("body").innerText(), /Success!|Transfer successful!/);
        await collect(page);
        assert.equal((await page.locator("body").innerText()).includes("The transaction was submitted, but final confirmation is still unavailable. Check the Explorer before trying again."), true,
          "an uncertain submitted operation must retain its explicit no-retry/manual-verification explanation in the active UI");
      } finally { await page.close(); }
    });

    await t.test("real Chromium same-origin Web Lock rejects another tab without queuing a stale Send intent", async () => {
      const first = await createPage();
      const second = await createPage({ origin: first.origin, surface: "studio" });
      try {
        await fillTransfer(first.page, "dashboard"); await fillTransfer(second.page, "studio");
        await first.page.evaluate(() => window.phase5cSend.hold("status"));
        await sendButton(first.page, "dashboard").click();
        await first.page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.stats().getStatus >= 1");
        const lock = await first.page.evaluate(async () => (await navigator.locks.query()).held?.map((value) => ({ name: value.name, mode: value.mode })));
        assert.deepEqual(lock, [{ name: "thru.write:betanet:2", mode: "exclusive" }]);
        await sendButton(second.page, "studio").click();
        await second.page.waitForFunction("document.body.textContent.includes('Another write is active or still awaiting verification')");
        assert.equal((await stats(second.page)).send, 0); assert.equal((await stats(second.page)).sign, 0);
        assert.equal((await state(second.page)).journalCount, 1); assert.equal((await state(second.page)).fenceCount, 1);
        await first.page.evaluate(() => window.phase5cSend.release("status"));
        await first.page.waitForFunction("document.body.textContent.includes('Success!')");
        assert.equal((await stats(first.page)).send, 1); assert.equal((await stats(second.page)).send, 0);
        assert.deepEqual(await first.page.evaluate(async () => (await navigator.locks.query()).held), []);
        assert.equal((await state(second.page)).journalCount, 0); assert.equal((await state(second.page)).fenceCount, 0);
        await collect(first.page); await collect(second.page);
      } finally { await first.page.close(); await second.page.close(); }
    });

    await t.test("real network-wide Web Lock also excludes a different wallet in a second same-origin tab", async () => {
      const first = await createPage();
      const second = await createPage({ origin: first.origin });
      try {
        await second.page.evaluate(() => window.phase5cSend.wallet("b"));
        await second.page.waitForFunction("window.phase5cSend.publicState().wallet === 'b' && window.phase5cSend.publicState().ready");
        await fillTransfer(first.page, "dashboard"); await fillTransfer(second.page, "dashboard", "0.1");
        await first.page.evaluate(() => window.phase5cSend.hold("status"));
        await sendButton(first.page, "dashboard").click();
        await first.page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.stats().getStatus >= 1");
        await sendButton(second.page, "dashboard").click();
        await second.page.waitForFunction("document.body.textContent.includes('Another write is active or still awaiting verification')");
        assert.equal((await stats(second.page)).send, 0); assert.equal((await stats(second.page)).sign, 0);
        await first.page.evaluate(() => window.phase5cSend.release("status"));
        await first.page.waitForFunction("document.body.textContent.includes('Success!')");
        assert.equal((await stats(first.page)).send, 1); assert.equal((await stats(second.page)).send, 0);
        await collect(first.page); await collect(second.page);
      } finally { await first.page.close(); await second.page.close(); }
    });

    await t.test("same-frame duplicate clicks are not queued while the actual hook owns an in-flight operation", async () => {
      const { page } = await createPage();
      try {
        await fillTransfer(page, "dashboard"); await page.evaluate(() => window.phase5cSend.hold("status"));
        await page.evaluate(() => {
          const button = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((item) => item.textContent?.trim() === "Review Send");
          if (!button) throw new Error("Missing real Send submit control");
          button.click(); button.click();
        });
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.stats().getStatus >= 1");
        assert.equal((await stats(page)).sign, 1); assert.equal((await stats(page)).send, 1);
        await page.evaluate(() => window.phase5cSend.release("status"));
        await page.waitForFunction("document.body.textContent.includes('Success!')");
        assert.equal((await stats(page)).send, 1); assert.equal((await state(page)).refreshCalls, 1);
        await collect(page);
      } finally { await page.close(); }
    });

    await t.test("reload preserves an unresolved public journal/fence and original-signature recovery is read-only", async () => {
      const { page } = await createPage({ config: { mode: "signaturemismatch" } });
      try {
        await fillTransfer(page, "dashboard"); await sendButton(page, "dashboard").click();
        await page.waitForFunction("window.phase5cSend.stats().send === 1 && window.phase5cSend.publicState().journalCount === 1 && [...document.querySelectorAll('button')].some(button => button.type === 'submit' && button.textContent.trim() === 'Review Send')");
        const originalSignatures = (await state(page)).journalSignatures;
        assert.equal(originalSignatures.length, 1); await collect(page);
        await page.reload(); await install(page);
        assert.deepEqual((await state(page)).journalSignatures, originalSignatures);
        assert.equal((await state(page)).fenceCount, 1); assert.equal((await stats(page)).send, 0);
        assert.equal(await page.evaluate(() => window.phase5cSend.prepareRecoveryEvidence()), 1);
        await fillTransfer(page, "dashboard");
        await sendButton(page, "dashboard").click();
        await page.waitForFunction("document.body.textContent.includes('Success!')");
        const after = await stats(page);
        assert.equal(after.build, 0); assert.equal(after.sign, 0); assert.equal(after.send, 0);
        assert.ok(after.getStatus >= 1); assert.equal((await state(page)).journalCount, 0); assert.equal((await state(page)).fenceCount, 0);
        await collect(page);
      } finally { await page.close(); }
    });

    assert.deepEqual(unexpected, [], "No browser request may leave the explicitly fulfilled local origins");
    assert.deepEqual(guard.denied, [], "No Node transport may leave the isolated harness");
    assert.deepEqual(exceptions, [], "Unexpected browser exceptions are not suppressed");
    assert.deepEqual(consoleErrors, [], "Unexpected browser warnings/errors are not suppressed");
    assert.equal(totals.browserDenied, 0); assert.equal(totals.sdkForbidden, 0);
    t.diagnostic(`Phase 5C isolated browser totals: origins=${originCount}; build=${totals.build}; fakeSign=${totals.sign}; fakeSend=${totals.send}; fakeStatus=${totals.status}; proofs=${totals.proof}; journal writes=${totals.journalWrites}; journal reads=${totals.journalReads}; journal read-backs=${totals.journalReadBacks}; fence writes=${totals.fenceWrites}; fence reads=${totals.fenceReads}; blocked browser escape-hatch attempts=${totals.browserDenied}; SDK forbidden=${totals.sdkForbidden}; external browser requests=0; runner egress=0`);
  } finally {
    try { await context?.close(); }
    finally {
      guard.restore();
      const resolved = realpathSync(profile), temporaryRoot = realpathSync(tmpdir());
      assert.ok(resolved.toLowerCase().startsWith(temporaryRoot.toLowerCase() + path.sep));
      assert.ok(path.basename(resolved).startsWith("thru-port-phase5c-send-"));
      rmSync(resolved, { recursive: true, force: false });
    }
  }
});
