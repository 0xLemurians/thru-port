import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  NetworkHealthProbeSequence,
  isUsableNetworkHeightSnapshot,
  probeNetworkHealth,
  type NetworkStatus,
} from "../lib/network/network-health";

test("transport success without usable height state is Degraded, not Online", async () => {
  assert.equal(await probeNetworkHealth(async () => ({})), "Degraded");
});

test("SDK-style empty height response is Degraded", async () => {
  assert.equal(
    await probeNetworkHealth(async () => ({
      finalized: 0n,
      locallyExecuted: 0n,
      clusterExecuted: 0n,
    })),
    "Degraded",
  );
});

test("positive internally consistent SDK height state is Online", async () => {
  const snapshot = {
    finalized: 100n,
    locallyExecuted: 102n,
    clusterExecuted: 101n,
  };
  assert.equal(isUsableNetworkHeightSnapshot(snapshot), true);
  assert.equal(await probeNetworkHealth(async () => snapshot), "Online");
});

test("partial or inconsistent height state is Degraded", async () => {
  assert.equal(
    await probeNetworkHealth(async () => ({
      finalized: 100n,
      locallyExecuted: 99n,
      clusterExecuted: 101n,
    })),
    "Degraded",
  );
  assert.equal(
    await probeNetworkHealth(async () => ({
      finalized: 100n,
      locallyExecuted: 102n,
    })),
    "Degraded",
  );
});

test("RPC rejection is Offline", async () => {
  assert.equal(
    await probeNetworkHealth(async () => {
      throw new Error("transport unavailable");
    }),
    "Offline",
  );
});

test("RPC timeout is Offline", async () => {
  assert.equal(
    await probeNetworkHealth(
      () => new Promise<never>(() => {}),
      { timeoutMs: 5 },
    ),
    "Offline",
  );
});

test("a stale probe cannot overwrite a newer status", () => {
  const sequence = new NetworkHealthProbeSequence();
  const olderProbe = sequence.begin();
  const newerProbe = sequence.begin();
  let status: NetworkStatus = "Checking";

  if (sequence.isCurrent(newerProbe)) status = "Degraded";
  if (sequence.isCurrent(olderProbe)) status = "Online";

  assert.equal(olderProbe.signal.aborted, true);
  assert.equal(sequence.isCurrent(olderProbe), false);
  assert.equal(sequence.isCurrent(newerProbe), true);
  assert.equal(status, "Degraded");
});

test("visibility cancellation invalidates the active probe", () => {
  const sequence = new NetworkHealthProbeSequence();
  const activeProbe = sequence.begin();
  sequence.cancel();
  assert.equal(activeProbe.signal.aborted, true);
  assert.equal(sequence.isCurrent(activeProbe), false);
});

test("AppFlow owns one centralized health result for all workspaces", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/AppFlow.tsx"),
    "utf8",
  );
  assert.equal(source.match(/useNetworkHealth\(\)/g)?.length, 1);
  assert.match(source, /<CommandShell[\s\S]*health=\{health\}/);
  assert.match(source, /<CommandDashboard[\s\S]*health=\{health\}/);
  assert.match(source, /<TokenStudio account=\{account\} health=\{health\}/);
  assert.match(source, /<NameStudio[\s\S]*health=\{health\}/);
});
