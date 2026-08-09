import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SignatureDomain,
  TransactionSigningScheme,
  TransactionBuilder,
  attachTransactionSignature,
  buildSignedMessage,
  buildTransactionSigningMessage,
  signWithDomain,
  verifyWithDomain,
  type BuildTransactionOptions,
} from "@thru/sdk";
import {
  assertUsableTransactionContext,
  buildTransactionForSigning,
  readFreshChainId,
} from "../lib/thru/transactions";

interface SigningFixture {
  fixture: string;
  warning: string;
  source: string;
  transactionDomain: string;
  publicTestSeedHex: string;
  publicKeyHex: string;
  officialRustGoldenBodyHex: string;
  officialRustGoldenSignatureHex: string;
  unsignedTransactionBodyHex: string;
  signingMessageHex: string;
  signatureHex: string;
  signedWireHex: string;
  legacyV0_2_39MinimalBodySignatureHex: string;
}

const ROOT = process.cwd();
const fixture = JSON.parse(
  readFileSync(
    path.join(
      ROOT,
      "tests",
      "fixtures",
      "thru-transaction-signing-v0.3.4.json",
    ),
    "utf8",
  ),
) as SigningFixture;

function hexToBytes(hex: string): Uint8Array {
  assert.match(hex, /^(?:[0-9a-f]{2})*$/i);
  return Uint8Array.from(
    hex.match(/.{2}/g)?.map((value) => Number.parseInt(value, 16)) ?? [],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function independentSigningMessage(
  body: Uint8Array,
): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      exactArrayBuffer(body),
    ),
  );
  return concatBytes(
    new TextEncoder().encode(fixture.transactionDomain),
    digest,
  );
}

async function independentWebCryptoSignature(
  body: Uint8Array,
): Promise<Uint8Array> {
  const seed = hexToBytes(fixture.publicTestSeedHex);
  const pkcs8Prefix = hexToBytes("302e020100300506032b657004220420");
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    exactArrayBuffer(concatBytes(pkcs8Prefix, seed)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const message = await independentSigningMessage(body);
  return new Uint8Array(
    await globalThis.crypto.subtle.sign(
      "Ed25519",
      privateKey,
      exactArrayBuffer(message),
    ),
  );
}

function transactionOptions(): BuildTransactionOptions {
  const program = new Uint8Array(32);
  program[31] = 3;
  return {
    feePayer: { publicKey: hexToBytes(fixture.publicKeyHex) },
    program,
    header: {
      fee: 0n,
      nonce: 0n,
      startSlot: 42n,
      expiryAfter: 100,
      chainId: 17,
      computeUnits: 10_000,
      stateUnits: 10_000,
      memoryUnits: 10_000,
    },
  };
}

function independentTransactionBody(): Uint8Array {
  const body = new Uint8Array(112);
  const view = new DataView(body.buffer);
  let offset = 0;
  view.setUint8(offset, 1);
  offset += 1;
  view.setUint8(offset, 0);
  offset += 1;
  view.setUint16(offset, 0, true);
  offset += 2;
  view.setUint16(offset, 0, true);
  offset += 2;
  view.setUint16(offset, 0, true);
  offset += 2;
  view.setUint32(offset, 10_000, true);
  offset += 4;
  view.setUint16(offset, 10_000, true);
  offset += 2;
  view.setUint16(offset, 10_000, true);
  offset += 2;
  view.setBigUint64(offset, 0n, true);
  offset += 8;
  view.setBigUint64(offset, 0n, true);
  offset += 8;
  view.setBigUint64(offset, 42n, true);
  offset += 8;
  view.setUint32(offset, 100, true);
  offset += 4;
  view.setUint16(offset, 17, true);
  offset += 2;
  offset += 2;
  body.set(hexToBytes(fixture.publicKeyHex), offset);
  offset += 32;
  body[body.length - 1] = 3;
  offset += 32;
  assert.equal(offset, body.length);
  return body;
}

function allSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return allSourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

test("the installed Thru dependency graph contains only matching 0.3.4 packages", () => {
  const appPackage = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const lock = JSON.parse(
    readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      { version?: string; dependencies?: Record<string, string> }
    >;
  };
  const installedSdk = JSON.parse(
    readFileSync(
      path.join(ROOT, "node_modules", "@thru", "sdk", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  const installedPrograms = JSON.parse(
    readFileSync(
      path.join(ROOT, "node_modules", "@thru", "programs", "package.json"),
      "utf8",
    ),
  ) as { version: string; dependencies: Record<string, string> };

  assert.equal(appPackage.dependencies["@thru/sdk"], "0.3.4");
  assert.equal(appPackage.dependencies["@thru/programs"], "0.3.4");
  assert.equal(installedSdk.version, "0.3.4");
  assert.equal(installedPrograms.version, "0.3.4");
  assert.equal(installedPrograms.dependencies["@thru/sdk"], "0.3.4");

  const sdkEntries = Object.entries(lock.packages).filter(([key]) =>
    /node_modules\/@thru\/sdk$/.test(key),
  );
  const programEntries = Object.entries(lock.packages).filter(([key]) =>
    /node_modules\/@thru\/programs$/.test(key),
  );
  assert.deepEqual(
    sdkEntries.map(([, value]) => value.version),
    ["0.3.4"],
  );
  assert.deepEqual(
    programEntries.map(([, value]) => value.version),
    ["0.3.4"],
  );
});

test("official RFC8032 golden signature remains stable in SDK 0.3.4", async () => {
  assert.match(fixture.warning, /PUBLIC TEST VECTOR ONLY/);
  assert.match(fixture.source, /Rust signer/);
  const body = hexToBytes(fixture.officialRustGoldenBodyHex);
  const seed = hexToBytes(fixture.publicTestSeedHex);
  const publicKey = hexToBytes(fixture.publicKeyHex);

  const independent = await independentWebCryptoSignature(body);
  const sdkSignature = await signWithDomain(
    body,
    seed,
    publicKey,
    SignatureDomain.TXN,
  );

  assert.equal(
    bytesToHex(independent),
    fixture.officialRustGoldenSignatureHex,
  );
  assert.equal(
    bytesToHex(sdkSignature),
    fixture.officialRustGoldenSignatureHex,
  );
  assert.equal(
    await verifyWithDomain(
      independent,
      body,
      publicKey,
      SignatureDomain.TXN,
    ),
    true,
  );
});

test("v0.3 unsigned body, signing message, signature, and signed wire match independently", async () => {
  const seed = hexToBytes(fixture.publicTestSeedHex);
  const independentBody = independentTransactionBody();
  const transaction = new TransactionBuilder().build(
    transactionOptions() as Parameters<TransactionBuilder["build"]>[0],
  );
  const body = transaction.toWireForSigning();
  const independentMessage = await independentSigningMessage(body);
  const independentSignature = await independentWebCryptoSignature(body);

  assert.equal(
    bytesToHex(independentBody),
    fixture.unsignedTransactionBodyHex,
  );
  assert.equal(bytesToHex(body), fixture.unsignedTransactionBodyHex);
  assert.equal(bytesToHex(independentMessage), fixture.signingMessageHex);
  assert.equal(
    bytesToHex(buildSignedMessage(body, SignatureDomain.TXN)),
    fixture.signingMessageHex,
  );
  assert.equal(bytesToHex(independentSignature), fixture.signatureHex);
  assert.equal(
    bytesToHex(concatBytes(independentBody, independentSignature)),
    fixture.signedWireHex,
  );

  const signingMessage = buildTransactionSigningMessage(body);
  assert.equal(bytesToHex(signingMessage.m), fixture.signingMessageHex);
  assert.equal(
    bytesToHex(
      await attachTransactionSignature(
        signingMessage,
        independentSignature,
      ),
    ),
    fixture.signedWireHex,
  );

  await transaction.sign(seed);
  assert.equal(bytesToHex(transaction.toWire()), fixture.signedWireHex);
});

test("body mutation and the legacy 0.2.39 signature fail v0.3 verification", async () => {
  const publicKey = hexToBytes(fixture.publicKeyHex);
  const signature = hexToBytes(fixture.signatureHex);
  const mutated = hexToBytes(fixture.unsignedTransactionBodyHex);
  mutated[32] ^= 1;

  assert.equal(
    await verifyWithDomain(
      signature,
      mutated,
      publicKey,
      SignatureDomain.TXN,
    ),
    false,
  );

  const legacyBody = new Uint8Array(120);
  legacyBody.set(publicKey, 48);
  assert.equal(
    await verifyWithDomain(
      hexToBytes(fixture.legacyV0_2_39MinimalBodySignatureHex),
      legacyBody,
      publicKey,
      SignatureDomain.TXN,
    ),
    false,
  );
});

test("fresh transaction context is validated and an abort blocks later signing", async () => {
  const validTransaction = new TransactionBuilder().build(
    transactionOptions() as Parameters<TransactionBuilder["build"]>[0],
  );
  assert.doesNotThrow(() => assertUsableTransactionContext(validTransaction));
  assert.throws(
    () =>
      assertUsableTransactionContext({
        chainId: 0,
        startSlot: 42n,
      }),
    /chain ID/,
  );
  assert.throws(
    () =>
      assertUsableTransactionContext({
        chainId: 17,
        startSlot: 0n,
      }),
    /finalized slot/,
  );

  let releaseBuild!: (value: typeof validTransaction) => void;
  const controller = new AbortController();
  const pending = buildTransactionForSigning(
    transactionOptions(),
    controller.signal,
    () =>
      new Promise((resolve) => {
        releaseBuild = resolve;
      }),
  );
  controller.abort();
  releaseBuild(validTransaction);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(validTransaction.getSignature(), undefined);
});

test("account-create chain IDs are fresh, validated, and never hardcoded", async () => {
  const reads: number[] = [];
  assert.equal(
    await readFreshChainId(undefined, async () => {
      reads.push(23);
      return 23;
    }),
    23,
  );
  assert.deepEqual(reads, [23]);
  await assert.rejects(
    () => readFreshChainId(undefined, async () => 0),
    /chain ID/,
  );

  let releaseRead!: (value: number) => void;
  const controller = new AbortController();
  const pending = readFreshChainId(
    controller.signal,
    () =>
      new Promise((resolve) => {
        releaseRead = resolve;
      }),
  );
  controller.abort();
  releaseRead(23);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});

test("production transaction paths use the centralized official SDK signer only", () => {
  const sourceFiles = [
    ...allSourceFiles(path.join(ROOT, "app")),
    ...allSourceFiles(path.join(ROOT, "components")),
    ...allSourceFiles(path.join(ROOT, "lib")),
  ];
  const source = sourceFiles
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  assert.doesNotMatch(
    source,
    /legacySigning|domain-signing-legacy|DOMAIN_BLOCK_SIZE/,
  );
  assert.doesNotMatch(source, /\.legacySign\s*\(/);
  assert.doesNotMatch(source, /TransactionSigningScheme\.Legacy/);
  assert.doesNotMatch(source, /tn_txn_sign_v1__/);
  assert.doesNotMatch(source, /buildAndSign/);

  const clientSource = readFileSync(
    path.join(ROOT, "lib", "thru", "client.ts"),
    "utf8",
  );
  assert.match(
    clientSource,
    /transactionSigningScheme:\s*TransactionSigningScheme\.Rfc8032/,
  );
  assert.equal(TransactionSigningScheme.Rfc8032, "rfc8032");

  const directSigners = sourceFiles.filter((file) =>
    /\.sign\(/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    directSigners.map((file) => path.relative(ROOT, file).replaceAll("\\", "/")),
    ["lib/thru/transactions.ts"],
  );

  for (const relative of [
    "lib/wallet/thru-wallet.ts",
    "lib/wallet/faucet.ts",
    "lib/token/thru-token.ts",
    "lib/thru/name-service/purchase.ts",
  ]) {
    assert.match(
      readFileSync(path.join(ROOT, relative), "utf8"),
      /signTransactionForSubmission/,
      `${relative} must use the centralized SDK signing guard`,
    );
  }

  const faucetSource = readFileSync(
    path.join(ROOT, "lib", "wallet", "faucet.ts"),
    "utf8",
  );
  assert.ok(
    faucetSource.indexOf("await ensureAccountExists") <
      faucetSource.indexOf("await attemptFaucetWithdraw"),
    "faucet funding must wait for verified account creation",
  );
});
