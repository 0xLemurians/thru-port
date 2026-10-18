import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { build } from "esbuild";
import type { storageQA } from "./fixtures/phase5b-storage-harness";

interface StoragePage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<Awaited<T>>;
  on(event: "pageerror", callback: () => void): void;
  on(event: "console", callback: (message: { type(): string }) => void): void;
}
interface ChromiumContext {
  cookies(): Promise<unknown[]>;
  newPage(): Promise<StoragePage>;
  route(pattern: string, callback: (route: { request(): { url(): string };
    fulfill(options: { status: number; contentType: string; body: string }): Promise<void>; abort(): Promise<void> }) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
interface Runtime { chromium: { executablePath(): string;
  launchPersistentContext(profile: string, options: { headless: boolean; executablePath: string; serviceWorkers: "block"; args: string[] }): Promise<ChromiumContext> } }
type StorageAPI = typeof storageQA;
declare global { interface Window { phase5bStorage: StorageAPI; phase5bStorageTransportAttempts: number; } }

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127\.\d+\.\d+\.\d+$/.test(normalized);
}

function httpHost(args: unknown[]): string {
  const urlOrOptions = args[0];
  const options = args.find((arg) => arg !== null && typeof arg === "object" && !(arg instanceof URL)) as
    { hostname?: string; host?: string; socketPath?: string } | undefined;
  if (options?.socketPath) return "localhost";
  if (options?.hostname) return options.hostname;
  if (options?.host) {
    try { return new URL(`http://${options.host}`).hostname; }
    catch { return "invalid-denied-host"; }
  }
  if (urlOrOptions instanceof URL) return urlOrOptions.hostname;
  if (typeof urlOrOptions === "string") {
    try { return new URL(urlOrOptions).hostname; }
    catch { return "invalid-denied-host"; }
  }
  return "localhost";
}

function installRunnerEgressGuard() {
  const originals = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get, socketConnect: net.Socket.prototype.connect };
  let denied = 0;
  const deny = (): never => { denied++; throw new Error("Phase 5B runner external network denied"); };
  const checkHttp = (args: unknown[]) => { if (!isLoopback(httpHost(args))) deny(); };
  globalThis.fetch = (() => deny()) as typeof fetch;
  http.request = function(...args: unknown[]) { checkHttp(args); return Reflect.apply(originals.httpRequest, http, args); } as typeof http.request;
  http.get = function(...args: unknown[]) { checkHttp(args); return Reflect.apply(originals.httpGet, http, args); } as typeof http.get;
  https.request = function(...args: unknown[]) { checkHttp(args); return Reflect.apply(originals.httpsRequest, https, args); } as typeof https.request;
  https.get = function(...args: unknown[]) { checkHttp(args); return Reflect.apply(originals.httpsGet, https, args); } as typeof https.get;
  net.Socket.prototype.connect = function(this: net.Socket, ...args: unknown[]) {
    // Playwright uses inherited stdio pipes; loopback/IPC remain available to its local transport.
    const first = args[0];
    if (typeof first === "number") {
      if (!isLoopback(typeof args[1] === "string" ? args[1] : "localhost")) deny();
    } else if (first && typeof first === "object") {
      const options = first as { host?: string; path?: string };
      if (!options.path && !isLoopback(options.host ?? "localhost")) deny();
    }
    return Reflect.apply(originals.socketConnect, this, args);
  } as typeof net.Socket.prototype.connect;
  return { denied: () => denied, restore() {
    globalThis.fetch = originals.fetch; http.request = originals.httpRequest; http.get = originals.httpGet;
    https.request = originals.httpsRequest; https.get = originals.httpsGet;
    net.Socket.prototype.connect = originals.socketConnect;
  } };
}

test("Phase 5B real Chromium IndexedDB wallet storage is isolated and fail-closed", { timeout: 90_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const bundled = path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  // Missing installed tooling is an explicit failure; never download dependencies or silently skip security coverage.
  const runtime = require(process.env.PLAYWRIGHT_MODULE_PATH ?? (existsSync(bundled) ? bundled : "playwright")) as Runtime;
  const executablePath = [runtime.chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  assert.ok(executablePath, "Installed Chromium is required; this test does not install a browser");
  const directory = mkdtempSync(path.join(tmpdir(), "thru-phase5b-storage-"));
  const profile = path.join(directory, "profile");
  const origin = `http://phase5b-${randomUUID()}.localhost`;
  const runnerEgress = installRunnerEgressGuard();
  let context: ChromiumContext | null = null;
  const unexpected: string[] = [];
  let pageErrors = 0, consoleErrors = 0, allowedDocuments = 0;
  try {
    const result = await build({ entryPoints: ["tests/fixtures/phase5b-storage-harness.ts"], bundle: true, write: false,
      platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
    context = await runtime.chromium.launchPersistentContext(profile, { headless: true, executablePath,
      serviceWorkers: "block", args: ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions",
        "--disable-background-networking", "--disable-component-update", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"] });
    assert.deepEqual(await context.cookies(), []);
    await context.route("**/*", async (route) => {
      if (route.request().url() === `${origin}/`) {
        allowedDocuments++;
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body>Isolated storage QA</body></html>" });
      } else { unexpected.push(new URL(route.request().url()).hostname); await route.abort(); }
    });
    const page = await context.newPage();
    page.on("pageerror", () => { pageErrors++; });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors++; });
    await page.goto(`${origin}/`);
    assert.deepEqual(await page.evaluate(async () => ({ secure: isSecureContext, local: localStorage.length,
      session: sessionStorage.length, databases: (await indexedDB.databases()).length })),
    { secure: true, local: 0, session: 0, databases: 0 });
    const attach = async () => {
      await page.evaluate(() => {
        window.phase5bStorageTransportAttempts = 0;
        window.fetch = (() => {
          window.phase5bStorageTransportAttempts++;
          throw new Error("Phase 5B browser transport denied");
        }) as typeof fetch;
        XMLHttpRequest.prototype.open = function() {
          window.phase5bStorageTransportAttempts++;
          throw new Error("Phase 5B browser transport denied");
        };
      });
      await page.addScriptTag({ content: result.outputFiles[0].text });
    };
    await attach();

    await t.test("real structured clone preserves nonextractable AES-GCM key and encrypted-record read-back", async () => {
      await page.evaluate(() => window.phase5bStorage.saveFixture());
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.snapshot()), {
        restoredIdentityMatches: true, extractable: false, exportRejected: true, algorithm: "AES-GCM", deviceKeyCloned: true,
        ciphertextIsArrayBuffer: true, ivBytes: 12, recordVersion: 2, setupPending: true,
        recordHasOnlyApprovedFields: true, mnemonicAbsent: true,
      });
    });
    await t.test("reload restores the same fixture identity and interrupted setup marker", async () => {
      await page.reload(); await attach();
      const snapshot = await page.evaluate(() => window.phase5bStorage.snapshot());
      assert.equal(snapshot.restoredIdentityMatches, true); assert.equal(snapshot.setupPending, true);
      assert.equal(snapshot.extractable, false); assert.equal(snapshot.exportRejected, true);
    });
    await t.test("setup marker persists on write failure and clears only after verified completion", async () => {
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.setup()), {
        failedCode: "VAULT_SAVE_FAILED", pendingAfterFailure: true, completeAfterVerifiedWrite: true,
      });
    });
    for (const kind of ["missing-device-key", "ciphertext", "schema", "identity"] as const) {
      await t.test(`${kind} remains a corrupted vault instead of an empty wallet`, async () => {
        const value = await page.evaluate((corruption) => window.phase5bStorage.corrupt(corruption), kind);
        assert.equal(value, "VAULT_CORRUPTED");
      });
    }
    await t.test("storage denied or unavailable yields typed failures", async () => {
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.readUnavailable()), {
        unavailable: "VAULT_UNAVAILABLE", securityDenied: "VAULT_OPEN_FAILED",
      });
    });
    await t.test("quota-like encrypted-record write failure leaves prior vault restorable", async () => {
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.writeFailure()), { code: "VAULT_SAVE_FAILED", originalRestores: true });
    });
    await t.test("real deletion transaction abort rolls back both stores and rejects removal", async () => {
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.deletionAbort()), {
        code: "VAULT_DELETE_FAILED", bothRecordsRemain: true, restores: true,
      });
    });
    await t.test("verified deletion removes vault/key without deleting unrelated origin records", async () => {
      assert.deepEqual(await page.evaluate(() => window.phase5bStorage.removal()), { empty: true, unrelatedPreserved: true });
      await page.reload(); await attach();
      assert.equal(await page.evaluate(() => window.phase5bStorage.isEmpty()), true);
    });
    await t.test("transaction abort after request success must settle rather than leave wallet save pending", async () => {
      const result = await page.evaluate(() => window.phase5bStorage.abortSave());
      assert.equal(result.abortObserved, true);
      assert.equal(result.recordPreserved, true);
      assert.equal(result.outcome, "VAULT_SAVE_FAILED", "A real post-request transaction abort must reject the production save promise");
    });
    for (const stage of ["device-key", "encrypted-record", "setup-marker"] as const) {
      await t.test(`${stage} post-request abort rejects, preserves prior state and permits a subsequent verified write`, async () => {
        const result = await page.evaluate((writeStage) => window.phase5bStorage.abortWrite(writeStage), stage);
        assert.equal(result.requestSucceeded, true, "The real IDB request must succeed before its transaction is aborted");
        assert.equal(result.abortObserved, true);
        assert.equal(result.outcome, "VAULT_SAVE_FAILED", "Aborted writes must reject with the existing public vault error code");
        assert.equal(result.priorRecordPreserved, true, "An aborted write must not replace the previous encrypted record or wallet");
        assert.equal(result.noWalletAfterDeviceKeyAbort, true, "Device-key abort must not leave a falsely saved wallet");
        assert.equal(result.setupStillPending, stage !== "device-key", "Aborted setup completion must preserve its pending marker");
        assert.equal(result.subsequentOperationSucceeded, true);
        assert.equal(result.unhandledRejections, 0);
      });
    }
    assert.equal(pageErrors, 0, "No browser exceptions");
    assert.equal(consoleErrors, 0, "No console errors");
    assert.deepEqual(unexpected, [], "No unexpected browser request, including live RPC");
    assert.equal(await page.evaluate(() => window.phase5bStorageTransportAttempts), 0, "Browser transport was never invoked");
    assert.equal(runnerEgress.denied(), 0);
    t.diagnostic(`Real IndexedDB/WebCrypto; isolated documents=${allowedDocuments}; external browser requests=${unexpected.length}; runner external-network attempts=${runnerEgress.denied()}; RPC/sign/submit calls=0.`);
  } finally {
    try { await context?.close(); }
    finally {
      runnerEgress.restore();
      const resolved = path.resolve(directory), expectedParent = path.resolve(tmpdir());
      assert.equal(path.dirname(resolved), expectedParent);
      assert.ok(path.basename(resolved).startsWith("thru-phase5b-storage-"));
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});
