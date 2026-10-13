import assert from "node:assert/strict";
import test from "node:test";
import { Account, AccountView, ConsensusStatus, Pubkey, type ListAccountsOptions } from "@thru/sdk";
import { TokenAccount, TokenMintAccount } from "@thru/programs/token";
import { discoveryContinuationForRequest, discoverWalletHoldings, discoverWalletHoldingsOnce, DiscoveryRequestGuard, DISCOVERY_PROGRAM, type DiscoveryReader } from "../lib/token/discovery";
import { createThruAccountReader } from "../lib/thru/client";

// Public synthetic identities only. No keys, signing or network.
const address = (n: number) => Pubkey.from(new Uint8Array(32).fill(n)).toThruFmt();
const wallet = address(1), other = address(2), mintAddress = address(3), tokenAddress = address(4);
function envelope(publicAddress: string, data: Uint8Array, status = ConsensusStatus.INCLUDED): Account {
  return new Account({ address: Pubkey.from(publicAddress), meta: {
    version: 1, owner: Pubkey.from(DISCOVERY_PROGRAM), dataSize: data.length, seq: 1n, nonce: 1n, balance: 0n,
    flags: { isProgram: false, isPrivileged: false, isUncompressable: false, isEphemeral: false,
      isDeleted: false, isNew: false, isCompressed: false },
  }, data: { data, compressed: false }, consensusStatus: status, versionContext: { slot: 100n, seq: 1n } });
}
function token(publicAddress = tokenAddress, owner = wallet, mint = mintAddress, amount = 7n): Account {
  return envelope(publicAddress, TokenAccount.builder().set_mint(Pubkey.from(mint).toBytes())
    .set_owner(Pubkey.from(owner).toBytes()).set_amount(amount).set_is_frozen(0).build());
}
function mint(decimals = 6, publicAddress = mintAddress): Account {
  const ticker = new Uint8Array(9); ticker.set([3, 84, 75, 78]);
  return envelope(publicAddress, TokenMintAccount.builder().set_decimals(decimals).set_supply(100n)
    .set_creator(Pubkey.from(other).toBytes()).set_mint_authority(Pubkey.from(other).toBytes())
    .set_freeze_authority(new Uint8Array(32)).set_has_freeze_authority(0).set_ticker(ticker).build());
}
function metadata(account: Account): Account { return new Account({ ...account, data: undefined }); }
function setup(rows: Account[] = [metadata(token())], accounts = new Map([[tokenAddress, token()], [mintAddress, mint()]])) {
  const calls: string[] = [], queries: ListAccountsOptions[] = [];
  const reader: DiscoveryReader = {
    list: async (query) => { queries.push(query); return { accounts: rows }; },
    get: async (publicAddress) => {
      calls.push(publicAddress);
      const account = accounts.get(publicAddress);
      if (!account) throw Object.assign(new Error("not found"), { code: 5 });
      return account;
    },
  };
  return { reader, calls, queries };
}

test("empty transaction history is irrelevant: received-only holdings use canonical account inventory", async () => {
  const s = setup();
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, now: () => 1000 });
  assert.equal(result.state, "exhausted"); assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].mint.creator, other);
  assert.equal(result.holdings[0].accounts[0].state.owner, wallet);
  assert.equal(s.queries[0].view, AccountView.FULL);
  assert.equal(s.queries[0].minConsensus, ConsensusStatus.INCLUDED);
  assert.match(s.queries[0].filter!.expression ?? "", /account.meta.owner.value == params.owner_bytes/);
  assert.match(s.queries[0].filter!.expression ?? "", /uint\(73\)/);
  assert.equal(result.verifiedAt, 1000);
});
test("FULL inventory without payload performs exact token and mint point reads", async () => {
  const s = setup(); await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.deepEqual(s.calls, [tokenAddress, mintAddress]);
});
test("inventory payload can be decoded without redundant token point reads", async () => {
  const s = setup([token()]); await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.deepEqual(s.calls, [mintAddress]);
});
test("payload owner, not metadata owner, determines wallet holdings", async () => {
  const s = setup([token(tokenAddress, other)]);
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.deepEqual(result.holdings, []); assert.equal(result.state, "exhausted");
  assert.equal(s.calls.length, 0);
});
test("custom-seed account addresses and multiple accounts per mint survive grouping/deduplication", async () => {
  const custom = address(42), another = address(43);
  const rows = [token(custom), token(another, wallet, mintAddress, 11n), token(custom)];
  const s = setup(rows);
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.equal(result.holdings.length, 1);
  assert.deepEqual(result.holdings[0].accounts.map((a) => a.address), [custom, another]);
  assert.equal(result.holdings[0].accounts[1].state.amount, 11n);
  assert.deepEqual(s.calls, [mintAddress]); // Per-scan mint memoization.
});
for (const mode of ["wrong-address", "wrong-program", "short-payload", "extra-payload", "deleted", "compressed", "ephemeral", "program", "invalid-frozen"] as const) {
  test("invalid token candidate fails closed: " + mode, async () => {
    const normal = token();
    let invalid = normal;
    if (mode === "wrong-address") invalid = new Account({ ...normal, address: Pubkey.from(other) });
    if (mode === "wrong-program") invalid = new Account({ ...normal, meta: { ...normal.meta!, owner: Pubkey.from(other) } });
    if (mode === "short-payload" || mode === "extra-payload") {
      const data = new Uint8Array(mode === "short-payload" ? 72 : 74);
      invalid = new Account({ ...normal, data: { data, compressed: false } });
    }
    if (mode === "deleted" || mode === "compressed" || mode === "ephemeral" || mode === "program") {
      invalid = new Account({ ...normal, meta: { ...normal.meta!, flags: { ...normal.meta!.flags,
        isDeleted: mode === "deleted", isCompressed: mode === "compressed", isEphemeral: mode === "ephemeral", isProgram: mode === "program" } } });
    }
    if (mode === "invalid-frozen") {
      const data = normal.data!.data!.slice(); data[72] = 2;
      invalid = new Account({ ...normal, data: { data, compressed: false } });
    }
    const s = setup(); s.reader.get = async (a) => a === tokenAddress ? invalid : mint();
    const result = await discoverWalletHoldings(wallet, { reader: s.reader });
    assert.equal(result.holdings.length, 0); assert.equal(result.state, "partial");
    assert.deepEqual(result.continuation?.pendingAddresses, [tokenAddress]);
    assert.equal(result.candidateReadFailures, 1);
  });
}
for (const mode of ["missing-data", "wrong-address", "wrong-program", "missing-decimals", "bad-ticker", "bad-freeze"] as const) {
  test("mint verification rejects missing/invalid metadata: " + mode, async () => {
    let invalid = mint();
    if (mode === "missing-data") invalid = metadata(invalid);
    if (mode === "wrong-address") invalid = new Account({ ...invalid, address: Pubkey.from(other) });
    if (mode === "wrong-program") invalid = new Account({ ...invalid, meta: { ...invalid.meta!, owner: Pubkey.from(other) } });
    if (mode === "missing-decimals") invalid = new Account({ ...invalid, data: { data: invalid.data!.data!.slice(1), compressed: false } });
    if (mode === "bad-ticker" || mode === "bad-freeze") {
      const data = invalid.data!.data!.slice(); data[mode === "bad-ticker" ? 106 : 105] = mode === "bad-ticker" ? 9 : 2;
      invalid = new Account({ ...invalid, data: { data, compressed: false } });
    }
    const s = setup(); s.reader.get = async (a) => a === tokenAddress ? token() : invalid;
    const result = await discoverWalletHoldings(wallet, { reader: s.reader });
    assert.deepEqual(result.holdings, []);
    assert.equal(result.state, "partial"); assert.ok(result.diagnostics.some((d) => d.stage === "mint"));
  });
}
test("ABI decimals are retained exactly; unsupported send decimals are not guessed or set to zero", async () => {
  const s = setup(); s.reader.get = async (a) => a === tokenAddress ? token() : mint(255);
  assert.equal((await discoverWalletHoldings(wallet, { reader: s.reader })).holdings[0].mint.decimals, 255);
});
test("INCLUDED and NEW data is a provisional ownership read, never execution/finality evidence", async () => {
  const s = setup();
  const normal = token();
  s.reader.get = async (a) => a === tokenAddress ? new Account({ ...normal, consensusStatus: ConsensusStatus.FINALIZED,
    meta: { ...normal.meta!, flags: { ...normal.meta!.flags, isNew: true } } }) : mint();
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.equal(result.holdings[0].accounts[0].finality, "provisional");
  assert.equal(result.holdings[0].mintFinality, "provisional");
});
test("cursor pages are bounded and continuation retains unprocessed candidates", async () => {
  const s = setup(); let pages = 0;
  s.reader.list = async (q) => {
    pages++; assert.equal(q.page?.pageToken, pages === 1 ? undefined : "page2");
    return { accounts: pages === 1 ? [token()] : [token(address(44))], page: { nextPageToken: pages === 1 ? "page2" : "" } };
  };
  const first = await discoverWalletHoldings(wallet, { reader: s.reader, maxPages: 1 });
  assert.equal(first.state, "partial"); assert.equal(first.continuation?.cursor, "page2"); assert.equal(pages, 1);
  const second = await discoverWalletHoldings(wallet, { reader: s.reader, continuation: first.continuation });
  assert.equal(second.state, "exhausted"); assert.equal(pages, 2);
});
test("duplicate and cyclic cursor results cannot run an unbounded inventory loop", async () => {
  const s = setup(); let pages = 0;
  s.reader.list = async () => ({ accounts: [token()], page: { nextPageToken: ++pages === 1 ? "same" : "same" } });
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, maxPages: 8 });
  assert.equal(pages, 2); assert.equal(result.state, "partial");
  assert.ok(result.diagnostics.some((d) => d.code === "cursor-cycle"));
  assert.equal(result.continuation?.cursor, null);
});
test("account budgets preserve remaining candidates without checkpoint loss", async () => {
  const s = setup([token(), token(address(45))]);
  const first = await discoverWalletHoldings(wallet, { reader: s.reader, maxAccounts: 1 });
  assert.equal(first.accountsInspected, 1); assert.equal(first.state, "partial");
  assert.deepEqual(first.continuation?.pendingAddresses, [address(45)]);
});
test("a transient 429 is not retried automatically; explicit resume retries the unresolved candidate", async () => {
  const s = setup(); let reads = 0;
  s.reader.get = async (a) => {
    if (a === tokenAddress && ++reads === 1) throw Object.assign(new Error("transport internals"), { code: 429 });
    return a === tokenAddress ? token() : mint();
  };
  const first = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.equal(reads, 1); assert.equal(first.state, "partial"); assert.equal(first.diagnostics[0].code, "rate-limited");
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /transport internals/);
  const resumed = await discoverWalletHoldings(wallet, { reader: s.reader, continuation: first.continuation });
  assert.equal(resumed.state, "exhausted"); assert.equal(reads, 2);
  assert.equal(resumed.pagesInspected, 0); assert.equal(resumed.holdings.length, 1);
});
test("partial RPC failures retain verified peers and unresolved addresses", async () => {
  const s = setup([token(), metadata(token(address(46)))]);
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.equal(result.holdings.length, 1); assert.equal(result.state, "partial");
  assert.deepEqual(result.continuation?.pendingAddresses, [address(46)]);
});
test("inventory RPC failure is unavailable rather than an authoritative empty wallet", async () => {
  const s = setup(); s.reader.list = async () => { throw new Error("RPC offline"); };
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.equal(result.state, "unavailable"); assert.equal(result.pagesInspected, 0);
  assert.ok(result.continuation);
});
test("hanging reads have a bounded deadline and preserve the failed candidate", async () => {
  const s = setup(); s.reader.get = () => new Promise(() => {});
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, requestTimeoutMs: 5, totalTimeoutMs: 100 });
  assert.equal(result.state, "partial"); assert.ok(result.diagnostics.some((d) => d.code === "timeout"));
  assert.deepEqual(result.continuation?.pendingAddresses, [tokenAddress]);
});
test("concurrency is capped at four and repeated mint reads share one request", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => metadata(token(address(60 + i))));
  const s = setup(rows); let active = 0, maximum = 0, mintReads = 0;
  s.reader.get = async (a) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    active--;
    if (a === mintAddress) { mintReads++; return mint(); }
    return token(a);
  };
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, concurrency: 99 });
  assert.equal(result.holdings[0].accounts.length, 10); assert.ok(maximum <= 4); assert.equal(mintReads, 1);
});
test("wallet switch and unmount cancel the real guard and reject late commits", async () => {
  const guard = new DiscoveryRequestGuard(); const job = guard.begin(wallet + ":betanet:2");
  let resolve!: (a: Account) => void;
  const s = setup(); s.reader.get = () => new Promise<Account>((done) => { resolve = done; });
  const pending = discoverWalletHoldings(wallet, { reader: s.reader, signal: job.signal });
  await new Promise<void>((done) => setTimeout(done, 0));
  guard.setScope(other + ":betanet:2"); resolve(token());
  const result = await pending;
  assert.equal(job.isCurrent(), false); assert.equal(job.signal.aborted, true);
  assert.equal(result.holdings.length, 0);
  const next = guard.begin(other + ":betanet:2"); guard.cancel();
  assert.equal(next.isCurrent(), false);
});
test("same scan subscribers deduplicate requests; one cancelled consumer does not cancel another", async () => {
  const s = setup(); let listCalls = 0, complete!: () => void;
  s.reader.list = async () => { listCalls++; await new Promise<void>((resolve) => { complete = resolve; }); return { accounts: [token()] }; };
  const abort = new AbortController();
  const first = discoverWalletHoldingsOnce(wallet, { reader: s.reader, signal: abort.signal });
  const second = discoverWalletHoldingsOnce(wallet, { reader: s.reader });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  abort.abort(); await assert.rejects(first, /stopped/); complete();
  assert.equal((await second).holdings.length, 1); assert.equal(listCalls, 1);
});
test("immediate refresh after the last subscriber aborts starts fresh read work, not a cancelled flight", async () => {
  const s = setup(); const completions: (() => void)[] = []; let lists = 0;
  s.reader.list = async () => { lists++; await new Promise<void>((done) => completions.push(done)); return { accounts: [token()] }; };
  const controller = new AbortController();
  const previous = discoverWalletHoldingsOnce(wallet, { reader: s.reader, signal: controller.signal });
  await new Promise<void>((done) => setTimeout(done, 0));
  controller.abort();
  const fresh = discoverWalletHoldingsOnce(wallet, { reader: s.reader });
  await assert.rejects(previous, /stopped/);
  await new Promise<void>((done) => setTimeout(done, 0));
  assert.equal(lists, 2); completions.forEach((done) => done());
  assert.equal((await fresh).state, "exhausted");
});
test("bounded cursor-history exhaustion is partial with no useless Continue action", async () => {
  const s = setup();
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, continuation: { version: 1,
    walletAddress: wallet, network: "betanet:2", program: DISCOVERY_PROGRAM, cursor: "c127",
    seenCursors: Array.from({ length: 128 }, (_, i) => "c" + i), pendingAddresses: [], inventoryExhausted: false } });
  assert.equal(result.state, "partial"); assert.equal(result.continuation, null); assert.equal(s.queries.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "budget-limit"));
});
test("a continuation from a different wallet or network is rejected before RPC", async () => {
  const s = setup(); const first = await discoverWalletHoldings(wallet, { reader: s.reader, maxPages: 1 });
  const continuation = { version: 1 as const, network: "alphanet:1", walletAddress: wallet, program: DISCOVERY_PROGRAM,
    cursor: null, seenCursors: [], pendingAddresses: [], inventoryExhausted: false };
  await assert.rejects(discoverWalletHoldings(wallet, { reader: s.reader, continuation }));
  assert.equal(s.queries.length, first.pagesInspected);
});
test("point reads older than listed account versions cannot become live holdings", async () => {
  const s = setup(); s.reader.get = async (a) => a === tokenAddress
    ? new Account({ ...token(), versionContext: { slot: 99n } }) : mint();
  const result = await discoverWalletHoldings(wallet, { reader: s.reader });
  assert.deepEqual(result.holdings, []); assert.equal(result.state, "partial");
  assert.deepEqual(result.continuation?.pendingAddresses, [tokenAddress]);
});
test("abort before scan never starts inventory or point reads", async () => {
  const s = setup(); const controller = new AbortController(); controller.abort();
  const result = await discoverWalletHoldings(wallet, { reader: s.reader, signal: controller.signal });
  assert.equal(result.state, "partial"); assert.equal(s.queries.length, 0); assert.equal(s.calls.length, 0);
});
test("refresh preserves unresolved candidates while restore/continue retain the saved inventory cursor", async () => {
  const s = setup(); s.reader.list = async () => ({ accounts: [metadata(token())], page: { nextPageToken: "page2" } });
  s.reader.get = async () => { throw Object.assign(new Error("temporarily unavailable"), { code: 8 }); };
  const first = await discoverWalletHoldings(wallet, { reader: s.reader });
  const resume = discoveryContinuationForRequest(first.continuation, wallet, true);
  assert.equal(resume?.cursor, "page2"); assert.deepEqual(resume?.pendingAddresses, [tokenAddress]);
  const refresh = discoveryContinuationForRequest(first.continuation, wallet, false);
  assert.equal(refresh?.cursor, null); assert.deepEqual(refresh?.seenCursors, []);
  assert.deepEqual(refresh?.pendingAddresses, [tokenAddress]);
  assert.equal(first.continuation?.cursor, "page2"); // Never mutate the cached checkpoint.
});
test("same wallet on a changed network invalidates the old discovery generation", () => {
  const guard = new DiscoveryRequestGuard(); const old = guard.begin(wallet + ":betanet:2");
  guard.setScope(wallet + ":another-network:3");
  assert.equal(old.isCurrent(), false); assert.equal(old.signal.aborted, true);
  const current = guard.begin(wallet + ":another-network:3"); assert.equal(current.isCurrent(), true); guard.cancel();
});
test("request-scoped official SDK transport receives cancellation, with no live RPC", async (t) => {
  const controller = new AbortController(); let calls = 0; let transportedSignal: AbortSignal | undefined;
  let started!: () => void; const waiting = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++; transportedSignal = init?.signal ?? undefined; started();
    return new Promise<Response>((_resolve, reject) => {
      transportedSignal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    });
  });
  const pending = createThruAccountReader(controller.signal, 100).get(tokenAddress, { view: AccountView.FULL });
  await waiting; controller.abort();
  await assert.rejects(pending);
  assert.equal(calls, 1); assert.equal(transportedSignal?.aborted, true);
  t.mock.restoreAll();
});
