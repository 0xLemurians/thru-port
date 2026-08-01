import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");

test("README documents the active Thru Port wallet and token application", () => {
  assert.match(readme, /Thru AlphaNet/);
  assert.match(readme, /@thru\/sdk@0\.3\.2/);
  assert.match(readme, /@thru\/programs@0\.3\.2/);
  assert.match(readme, /32-byte Ed25519 private key importu/);
  assert.match(readme, /IndexedDB/);
  assert.match(readme, /Token transferi/);
});

test("README accurately warns about backup v2 plaintext privateKey", () => {
  assert.match(readme, /Top-level `privateKey` alanı plaintext/);
  assert.match(readme, /Backup password.*top-level `privateKey` alanını korumaz/);
  assert.match(readme, /Legacy encrypted backup v1 importu/);
});

test("README does not claim recovery phrase, native send, or advanced markets are active", () => {
  assert.match(readme, /Visible Recovery Phrase importu bulunmaz/);
  assert.match(readme, /Native THRU send şu anda aktif değildir/);
  assert.match(readme, /Identity registration.*kapalıdır/);
  assert.match(readme, /AMM, Swap veya Pools/);
  assert.doesNotMatch(readme, /plaintext yerel backup indirme/);
  assert.doesNotMatch(readme, /Monaco Editor.*ana aktif workspace/i);
});
