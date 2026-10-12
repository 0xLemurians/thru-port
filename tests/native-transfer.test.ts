import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ConsensusStatus, EOA_PROGRAM_ID, Pubkey, SignatureDomain, Transaction, verifyWithDomain, type Account } from "@thru/sdk";
import { thru } from "../lib/thru/client";
import { accountFromPrivateKey, assertAccountIdentity } from "../lib/wallet/thru-wallet";
import { transferNativeUnits, reconcileNativeTransfer, type NativeTransferDependencies, type NativeTransferOptions } from "../lib/wallet/native-transfer";
import { assertNativeEoa, buildNativeTransferInstruction, NativeTransferError, NATIVE_TRANSFER_HEADER, NATIVE_U64_MAX, parseNativeTransferAmount, validateNativeTransferBalances } from "../lib/wallet/native-transfer-validation";
import { loadNativeTransfers, PENDING_NATIVE_TRANSFER_KEY, persistNativeTransfer, type NativeJournalStorage } from "../lib/wallet/pending-native-transfer";
import { type WriteLockProvider, WriteOperationBlockedError } from "../lib/thru/write-operation-guard";
import { PENDING_TOKEN_OPERATION_STORAGE_KEY } from "../lib/token/pending-operation";

// Existing independent public test fixture ONLY. Never used on-chain or logged/snapshotted.
const fixture: { publicTestSeedHex: string } = JSON.parse(readFileSync("tests/fixtures/thru-transaction-signing-v0.4.1.json", "utf8"));
const recipient = Pubkey.from(new Uint8Array(32).fill(71)).toThruFmt();
function memoryStorage(): NativeJournalStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function locks(): WriteLockProvider {
  let held = false;
  return { async request(_name, _options, callback) {
    if (held) return callback(null);
    held = true;
    try { return await callback({}); } finally { held = false; }
  } };
}
function eoa(address: string, balance = 100n, nonce = 7n): Account {
  return {
    address: Pubkey.from(address), consensusStatus: ConsensusStatus.INCLUDED,
    meta: { version: 1, dataSize: 0, seq: 1n, balance, nonce, owner: Pubkey.from(EOA_PROGRAM_ID),
      flags: { isProgram: false, isPrivileged: false, isUncompressable: false, isEphemeral: false, isDeleted: false, isNew: false, isCompressed: false } },
  } as Account;
}
async function setup() {
  const wallet = await accountFromPrivateKey(Uint8Array.from(Buffer.from(fixture.publicTestSeedHex, "hex")));
  const storage = memoryStorage();
  let sendCount = 0;
  let statusCount = 0;
  let reads = 0;
  let built: Transaction | undefined;
  let sent: Transaction | undefined;
  let clock = 1_000;
  const api: NativeTransferDependencies = {
    identity: assertAccountIdentity,
    readAccount: async (address) => { reads++; return eoa(address, address === wallet.address ? 100n : 0n); },
    chainId: async () => 2,
    finalizedSlot: async () => 100n,
    build: async (options) => { built = await thru.transactions.build(options); return built; },
    send: async (wire) => {
      sendCount++;
      sent = Transaction.fromWire(wire);
      const records = loadNativeTransfers(storage);
      assert.equal(records.length, 1, "journal is durable before send");
      assert.equal(records[0].signature, sent.getSignature()?.toThruFmt());
      return sent.getSignature()!.toThruFmt();
    },
    status: async () => {
      statusCount++;
      return { signature: sent!.getSignature()!.toBytes(), statusCode: ConsensusStatus.CLUSTER_EXECUTED,
        executionResult: { vmError: 0, userErrorCode: 0n, executionResult: 0n } };
    },
    transaction: async () => sent!,
  };
  const options: NativeTransferOptions = { dependencies: api, storage, locks: locks(), timeoutMs: 50, pollIntervalMs: 5, requestTimeoutMs: 20,
    now: () => clock, sleep: async (ms) => { clock += ms; } };
  return { wallet, api, storage, options, get sendCount() { return sendCount; }, get statusCount() { return statusCount; }, get reads() { return reads; },
    get built() { return built!; }, get sent() { return sent!; }, tick(ms: number) { clock += ms; } };
}

test("native instruction matches independent CLI bytes, exact offsets and u64 LE", () => {
  assert.equal(Buffer.from(buildNativeTransferInstruction(10n)).toString("hex"), "010000000a0000000000000000000200");
  const bytes = buildNativeTransferInstruction(NATIVE_U64_MAX);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.length, 16);
  assert.equal(view.getUint32(0, true), 1);
  assert.equal(view.getBigUint64(4, true), NATIVE_U64_MAX);
  assert.equal(view.getUint16(12, true), 0);
  assert.equal(view.getUint16(14, true), 2);
  assert.throws(() => buildNativeTransferInstruction(1n, 1, 2));
});
for (const input of ["0", "-1", "1.0", "1e3", "", " 1", "+1", "Infinity", (NATIVE_U64_MAX + 1n).toString()]) {
  test(`native amount rejects invalid integer syntax/bounds: ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseNativeTransferAmount(input), NativeTransferError);
  });
}
test("native amounts preserve u64 precision, including maximum", () => {
  assert.equal(parseNativeTransferAmount(NATIVE_U64_MAX.toString()), NATIVE_U64_MAX);
  assert.equal(parseNativeTransferAmount("9007199254740993"), 9007199254740993n);
});
test("fee, balance bounds and destination overflow are checked with BigInt", () => {
  validateNativeTransferBalances(11n, 0n, 10n);
  assert.throws(() => validateNativeTransferBalances(10n, 0n, 10n), /balance/i);
  assert.throws(() => validateNativeTransferBalances(100n, NATIVE_U64_MAX, 1n), /limit/i);
  assert.throws(() => validateNativeTransferBalances(-1n, 0n, 1n));
});
test("existing EOA preflight rejects non-EOA, unsupported flags and missing balance metadata", () => {
  assertNativeEoa(eoa(recipient), recipient);
  assert.throws(() => assertNativeEoa({ ...eoa(recipient), meta: undefined }, recipient));
  assert.throws(() => assertNativeEoa(eoa(recipient), Pubkey.from(new Uint8Array(32).fill(72)).toThruFmt()));
  for (const flag of ["isProgram", "isDeleted", "isCompressed", "isEphemeral", "isNew"] as const) {
    const account = eoa(recipient);
    assert.throws(() => assertNativeEoa({ ...account, meta: { ...account.meta!, flags: { ...account.meta!.flags, [flag]: true } } } as Account, recipient));
  }
  const account = eoa(recipient);
  assert.throws(() => assertNativeEoa({ ...account, meta: { ...account.meta!, owner: Pubkey.from(recipient) } } as Account, recipient));
});

test("official native build/sign/wire succeeds with exact CLI resource/account layout", async () => {
  const state = await setup();
  const result = await transferNativeUnits(state.wallet, recipient, "10", state.options);
  assert.equal(result.outcome, "success");
  assert.equal(state.sendCount, 1);
  assert.equal(state.built.feePayer.toThruFmt(), state.wallet.address);
  assert.equal(state.built.program.toThruFmt(), EOA_PROGRAM_ID);
  assert.deepEqual(state.built.readWriteAccounts.map((key) => key.toThruFmt()), [recipient]);
  assert.deepEqual(state.built.readOnlyAccounts, []);
  assert.equal(state.built.fee, NATIVE_TRANSFER_HEADER.fee);
  assert.equal(state.built.requestedComputeUnits, 10_000);
  assert.equal(state.built.requestedStateUnits, 0);
  assert.equal(state.built.requestedMemoryUnits, 10_000);
  assert.equal(state.built.expiryAfter, 100);
  assert.equal(state.built.flags, 0);
  assert.equal(state.built.chainId, 2);
  assert.equal(state.built.nonce, 7n);
  assert.equal(state.built.startSlot, 100n);
  assert.equal(state.built.feePayerStateProof, undefined);
  assert.equal(state.sent.toWireForSigning().length, 160);
  assert.equal(state.sent.toWire().length, 224);
  assert.equal(await verifyWithDomain(state.sent.getSignature()!.toBytes(), state.sent.toWireForSigning(), state.wallet.publicKey, SignatureDomain.TXN), true);
  const mutation = state.sent.toWireForSigning();
  mutation[116] ^= 1;
  assert.equal(await verifyWithDomain(state.sent.getSignature()!.toBytes(), mutation, state.wallet.publicKey, SignatureDomain.TXN), false);
  assert.deepEqual(loadNativeTransfers(state.storage), []);
  assert.match(result.explorerUrl, /scan\.thru\.org\/tx\/.*\?network=betanet$/);
  state.wallet.privateKey.fill(0);
});
test("invalid address and self-send fail before build/send", async () => {
  const state = await setup();
  await assert.rejects(transferNativeUnits(state.wallet, "invalid", "1", state.options), /address/i);
  await assert.rejects(transferNativeUnits(state.wallet, state.wallet.address, "1", state.options), /own wallet/i);
  assert.equal(state.sendCount, 0);
});
test("missing recipient rejects safely and cannot auto-create", async () => {
  const state = await setup();
  const read = state.api.readAccount;
  state.api.readAccount = async (address) => { if (address === recipient) throw new Error("[not_found] transport internal URL"); return read(address); };
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), (error: unknown) => error instanceof NativeTransferError && !/transport|URL/.test(error.message));
  assert.equal(state.sendCount, 0);
});
test("wrong network, invalid slot, and changing nonce prevent signing/submission", async () => {
  for (const mode of ["chain", "slot", "nonce"] as const) {
    const state = await setup();
    if (mode === "chain") state.api.chainId = async () => 1;
    if (mode === "slot") state.api.finalizedSlot = async () => 0n;
    if (mode === "nonce") {
      let sourceReads = 0;
      state.api.readAccount = async (address) => eoa(address, 100n, address === state.wallet.address && ++sourceReads > 1 ? 8n : 7n);
    }
    await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
    assert.equal(state.sendCount, 0);
    if (mode === "nonce") assert.equal(state.built.getSignature(), undefined);
  }
});
test("tampered builder accounts/header/instruction are rejected before signing", async () => {
  for (const change of ["fee", "program", "amount", "proof"] as const) {
    const state = await setup();
    const build = state.api.build;
    state.api.build = async (options) => {
      const transaction = await build(options);
      const header = { ...NATIVE_TRANSFER_HEADER, nonce: transaction.nonce, startSlot: transaction.startSlot, chainId: transaction.chainId };
      if (change === "amount") transaction.instructionData![4] ^= 1;
      else if (change === "fee") return new Transaction({ feePayer: transaction.feePayer, program: transaction.program, header: { ...header, fee: 0n }, accounts: { readWriteAccounts: [Pubkey.from(recipient).toBytes()] }, instructionData: transaction.instructionData });
      else if (change === "program") return new Transaction({ feePayer: transaction.feePayer, program: recipient, header, instructionData: transaction.instructionData });
      else return new Transaction({ feePayer: transaction.feePayer, program: transaction.program, header, accounts: { readWriteAccounts: [Pubkey.from(recipient).toBytes()] }, instructionData: transaction.instructionData, proofs: { feePayerStateProof: new Uint8Array([1]) } });
      return transaction;
    };
    await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
    assert.equal(state.sendCount, 0);
  }
});
test("1-3 transient not_found responses are visibility delay: one send, then success", async () => {
  const state = await setup();
  const status = state.api.status;
  let calls = 0;
  state.api.status = async (signature) => { if (++calls <= 3) throw new Error("[not_found] transaction not found"); return status(signature); };
  assert.equal((await transferNativeUnits(state.wallet, recipient, "10", state.options)).outcome, "success");
  assert.equal(calls, 4);
  assert.equal(state.sendCount, 1);
});
test("authoritative VM/user errors are failures, not retry or balance-based success", async () => {
  for (const error of [{ vmError: 1, userErrorCode: 0n }, { vmError: 0, userErrorCode: 9n }]) {
    const state = await setup();
    state.api.status = async () => ({ signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.FINALIZED, executionResult: error });
    const result = await transferNativeUnits(state.wallet, recipient, "1", state.options);
    assert.equal(result.outcome, "failure");
    assert.equal(result.vmError, error.vmError);
    assert.equal(result.userErrorCode, error.userErrorCode);
    assert.equal(state.sendCount, 1);
    assert.deepEqual(loadNativeTransfers(state.storage), []);
  }
});
test("INCLUDED execution (success or failure) never settles a native transfer", async () => {
  for (const vmError of [0, 1]) {
    const state = await setup();
    state.api.status = async () => ({ signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.INCLUDED, executionResult: { vmError, userErrorCode: 0n } });
    assert.equal((await transferNativeUnits(state.wallet, recipient, "1", state.options)).outcome, "uncertain");
    assert.equal(loadNativeTransfers(state.storage).length, 1);
    assert.equal(state.sendCount, 1);
  }
});
test("returned signature mismatch fails closed and keeps original public signature", async () => {
  const state = await setup();
  const send = state.api.send;
  state.api.send = async (raw) => { await send(raw); return "wrong"; };
  const result = await transferNativeUnits(state.wallet, recipient, "1", state.options);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.signature, state.sent.getSignature()!.toThruFmt());
  assert.equal(state.statusCount, 0);
  assert.equal(state.sendCount, 1);
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), WriteOperationBlockedError);
  assert.equal(state.sendCount, 1);
});
test("transport failure/timeout retains durable uncertainty, never exposes raw error", async () => {
  for (const mode of ["throw", "hang"] as const) {
    const state = await setup();
    const send = state.api.send;
    state.api.send = async (raw) => { await send(raw); if (mode === "throw") throw new Error("grpc proxy secret URL"); return new Promise<string>(() => {}); };
    const result = await transferNativeUnits(state.wallet, recipient, "1", state.options);
    assert.equal(result.outcome, "uncertain");
    assert.doesNotMatch(result.message!, /grpc|proxy|URL/);
    assert.equal(loadNativeTransfers(state.storage).length, 1);
    assert.equal(state.sendCount, 1);
  }
});
test("journal failure or partial write prevents the only submission", async () => {
  for (const mode of ["throw", "partial"] as const) {
    const state = await setup();
    const original = state.storage.setItem;
    state.storage.setItem = (key, value) => { if (mode === "throw") throw new Error("QuotaExceededError"); original(key, value.slice(0, -1)); };
    await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
    assert.equal(state.sendCount, 0);
  }
});
test("public journal retains very old unresolved records, strict fields, and network isolation", async () => {
  const state = await setup();
  state.api.status = async () => { throw new Error("not_found"); };
  await transferNativeUnits(state.wallet, recipient, "1", state.options);
  const record = loadNativeTransfers(state.storage)[0];
  persistNativeTransfer({ ...record, createdAt: 0 }, state.storage);
  assert.equal(loadNativeTransfers(state.storage)[0].createdAt, 0);
  assert.deepEqual(Object.keys(record).sort(), ["version", "network", "walletAddress", "recipientAddress", "amountRaw", "nonce", "startSlot", "signature", "bodyHash", "createdAt", "status"].sort());
  const clean = memoryStorage();
  clean.setItem("thru.nativeTransfers.alphanet:1.v1", JSON.stringify([record]));
  assert.deepEqual(loadNativeTransfers(clean), []);
  clean.setItem(PENDING_NATIVE_TRANSFER_KEY, JSON.stringify([{ ...record, network: "alphanet:1" }]));
  assert.throws(() => loadNativeTransfers(clean), NativeTransferError);
  clean.setItem(PENDING_NATIVE_TRANSFER_KEY, JSON.stringify([{ ...record, unexpected: "field" }]));
  assert.throws(() => loadNativeTransfers(clean), NativeTransferError);
});
test("reload recovery is read-only, verifies exact signed body, and clears only proven success", async () => {
  const state = await setup();
  const goodStatus = state.api.status;
  state.api.status = async () => { throw new Error("not_found"); };
  const pending = await transferNativeUnits(state.wallet, recipient, "1", state.options);
  assert.equal(pending.outcome, "uncertain");
  state.api.status = goodStatus;
  const readOnlyApi: NativeTransferDependencies = { ...state.api, identity: async () => { throw new Error("No keys allowed"); },
    build: async () => { throw new Error("No build allowed"); }, send: async () => { throw new Error("No send allowed"); } };
  const resolved = await reconcileNativeTransfer(state.wallet.address, { ...state.options, locks: locks(), dependencies: readOnlyApi });
  assert.equal(resolved?.outcome, "success");
  assert.equal(resolved?.signature, pending.signature);
  assert.equal(state.sendCount, 1);
  assert.deepEqual(loadNativeTransfers(state.storage), []);
});
test("unrelated balance changes or different transaction body cannot prove success", async () => {
  const state = await setup();
  const goodStatus = state.api.status;
  state.api.status = async () => { throw new Error("not_found"); };
  await transferNativeUnits(state.wallet, recipient, "1", state.options);
  state.api.readAccount = async (address) => eoa(address, 99n);
  assert.equal((await reconcileNativeTransfer(state.wallet.address, state.options))?.outcome, "uncertain");
  state.api.status = goodStatus;
  state.api.transaction = async () => { const other = Transaction.fromWire(state.sent.toWire()); other.instructionData![4] ^= 1; return other; };
  assert.equal((await reconcileNativeTransfer(state.wallet.address, state.options))?.outcome, "uncertain");
  assert.equal(loadNativeTransfers(state.storage).length, 1);
  assert.equal(state.sendCount, 1);
});
test("abort before submission never sends; abort after submission is durable uncertainty", async () => {
  const before = await setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transferNativeUnits(before.wallet, recipient, "1", { ...before.options, signal: controller.signal }), NativeTransferError);
  assert.equal(before.sendCount, 0);
  const after = await setup();
  const afterController = new AbortController();
  const send = after.api.send;
  after.api.send = async (raw) => { const result = await send(raw); afterController.abort(); return result; };
  assert.equal((await transferNativeUnits(after.wallet, recipient, "1", { ...after.options, signal: afterController.signal })).outcome, "uncertain");
  assert.equal(after.sendCount, 1);
  assert.equal(loadNativeTransfers(after.storage).length, 1);
  assert.equal(after.statusCount, 0);
});
test("hanging preflight expires without signing or any late submission", async () => {
  const state = await setup();
  let finish: ((id: number) => void) | undefined;
  state.api.chainId = () => new Promise((resolve) => { finish = resolve; });
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
  finish?.(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.sendCount, 0);
});
test("two tabs/requests cannot allocate the same nonce; second intent is never queued", async () => {
  const state = await setup();
  let finish: (() => void) | undefined;
  const chain = state.api.chainId;
  state.api.chainId = async () => { await new Promise<void>((resolve) => { finish = resolve; }); return chain(); };
  const first = transferNativeUnits(state.wallet, recipient, "1", state.options);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "2", state.options), WriteOperationBlockedError);
  state.api.chainId = chain;
  finish?.();
  assert.equal((await first).outcome, "success");
  assert.equal(state.sendCount, 1);
});
test("old unresolved token journal fences native transfers without age pruning", async () => {
  const state = await setup();
  state.storage.setItem(PENDING_TOKEN_OPERATION_STORAGE_KEY, JSON.stringify([{ walletAddress: state.wallet.address, createdAt: 0 }]));
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), WriteOperationBlockedError);
  assert.equal(state.sendCount, 0);
});
test("missing Web Locks fails closed for native transfer (no platform safety fallback)", async () => {
  const state = await setup();
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", { ...state.options, locks: undefined }), WriteOperationBlockedError);
  assert.equal(state.sendCount, 0);
});
test("failed cleanup does not turn authoritative success into a resendable failure", async () => {
  const state = await setup();
  const write = state.storage.setItem;
  state.storage.setItem = (key, value) => { if (key === PENDING_NATIVE_TRANSFER_KEY && value === "[]") throw new Error("Quota"); write(key, value); };
  const result = await transferNativeUnits(state.wallet, recipient, "1", state.options);
  assert.equal(result.outcome, "success");
  assert.equal(result.persistenceWarning, true);
  await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), WriteOperationBlockedError);
  assert.equal(state.sendCount, 1);
});

test("wallet identity mismatch and untrusted balance data fail before signing", async () => {
  const wrongKey = await setup();
  wrongKey.wallet.publicKey = Pubkey.from(recipient).toBytes();
  await assert.rejects(transferNativeUnits(wrongKey.wallet, recipient, "1", wrongKey.options), /signing wallet/i);
  assert.equal(wrongKey.sendCount, 0);
  const missing = await setup();
  missing.api.readAccount = async (address) => ({ address: Pubkey.from(address), consensusStatus: ConsensusStatus.INCLUDED }) as Account;
  await assert.rejects(transferNativeUnits(missing.wallet, recipient, "1", missing.options), NativeTransferError);
  assert.equal(missing.sendCount, 0);
});
test("live balances enforce fee and destination capacity before build", async () => {
  for (const mode of ["source", "destination"] as const) {
    const state = await setup();
    state.api.readAccount = async (address) => eoa(address, mode === "source" ? 1n : address === recipient ? NATIVE_U64_MAX : 100n);
    await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
    assert.equal(state.sendCount, 0);
  }
});
test("authoritative status without fresh execution details cannot reuse earlier INCLUDED success", async () => {
  const state = await setup();
  let count = 0;
  state.api.status = async () => (++count === 1 ? {
    signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.INCLUDED,
    executionResult: { vmError: 0, userErrorCode: 0n },
  } : { signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.FINALIZED });
  assert.equal((await transferNativeUnits(state.wallet, recipient, "1", state.options)).outcome, "uncertain");
  assert.equal(state.sendCount, 1);
});
test("fresh context expiry or chain change during build prevents local signing", async () => {
  for (const mode of ["slot", "chain"] as const) {
    const state = await setup();
    let count = 0;
    if (mode === "slot") state.api.finalizedSlot = async () => ++count === 1 ? 100n : 200n;
    else state.api.chainId = async () => ++count === 1 ? 2 : 1;
    await assert.rejects(transferNativeUnits(state.wallet, recipient, "1", state.options), NativeTransferError);
    assert.equal(state.built.getSignature(), undefined);
    assert.equal(state.sendCount, 0);
  }
});
test("hanging status request is bounded and leaves durable uncertainty", async () => {
  const state = await setup();
  state.api.status = () => new Promise(() => {});
  assert.equal((await transferNativeUnits(state.wallet, recipient, "1", state.options)).outcome, "uncertain");
  assert.equal(state.sendCount, 1);
  assert.equal(loadNativeTransfers(state.storage).length, 1);
});
test("readonly recovery of definitive failure clears pending identity without submission", async () => {
  const state = await setup();
  state.api.status = async () => { throw new Error("not_found"); };
  await transferNativeUnits(state.wallet, recipient, "1", state.options);
  state.api.status = async () => ({ signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.CLUSTER_EXECUTED,
    executionResult: { vmError: 3, userErrorCode: 0n } });
  assert.equal((await reconcileNativeTransfer(state.wallet.address, state.options))?.outcome, "failure");
  assert.equal(state.sendCount, 1);
  assert.deepEqual(loadNativeTransfers(state.storage), []);
});
test("aborted readonly recovery retains journal and makes no more status queries", async () => {
  const state = await setup();
  state.api.status = async () => { throw new Error("not_found"); };
  await transferNativeUnits(state.wallet, recipient, "1", state.options);
  const controller = new AbortController();
  controller.abort();
  let polls = 0;
  state.api.status = async () => { polls++; throw new Error("No poll allowed"); };
  assert.equal((await reconcileNativeTransfer(state.wallet.address, { ...state.options, signal: controller.signal }))?.outcome, "uncertain");
  assert.equal(polls, 0);
  assert.equal(state.sendCount, 1);
  assert.equal(loadNativeTransfers(state.storage).length, 1);
});

test("very large native transfer retains exact amount bytes and one-unit fee", async () => {
  const state = await setup();
  state.api.readAccount = async (address) => eoa(address, address === state.wallet.address ? NATIVE_U64_MAX : 0n);
  const amount = NATIVE_U64_MAX - 1n;
  assert.equal((await transferNativeUnits(state.wallet, recipient, amount.toString(), state.options)).outcome, "success");
  const bytes = state.sent.instructionData!;
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(4, true), amount);
  assert.equal(state.sendCount, 1);
});

test("a failure status with a nonmatching transaction body cannot clear the journal for retry", async () => {
  const state = await setup();
  state.api.status = async () => ({ signature: state.sent.getSignature()!.toBytes(), statusCode: ConsensusStatus.FINALIZED,
    executionResult: { vmError: 1, userErrorCode: 0n } });
  state.api.transaction = async () => { const other = Transaction.fromWire(state.sent.toWire()); other.instructionData![4] ^= 1; return other; };
  assert.equal((await transferNativeUnits(state.wallet, recipient, "1", state.options)).outcome, "uncertain");
  assert.equal(loadNativeTransfers(state.storage).length, 1);
  assert.equal(state.sendCount, 1);
});
