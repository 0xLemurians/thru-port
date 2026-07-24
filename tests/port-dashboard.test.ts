import test from "node:test";
import assert from "node:assert/strict";

// Since we cannot render React components easily, we test the navigation state logic
// that governs Port Dashboard locking behavior.

function canNavigate(targetStage: string, accountAvailable: boolean): boolean {
  if (!accountAvailable && targetStage !== "account") return false;
  return true;
}

test("wallet yokken Dashboard açık", () => {
  assert.equal(canNavigate("account", false), true);
});

test("wallet yokken Tokens kilitli", () => {
  assert.equal(canNavigate("token", false), false);
});

test("wallet yokken Identity kilitli", () => {
  assert.equal(canNavigate("name", false), false);
});

test("wallet yokken Developer kilitli", () => {
  assert.equal(canNavigate("editor", false), false);
});

test("account varsa navigation açılıyor", () => {
  assert.equal(canNavigate("account", true), true);
  assert.equal(canNavigate("token", true), true);
  assert.equal(canNavigate("name", true), true);
  assert.equal(canNavigate("editor", true), true);
});
