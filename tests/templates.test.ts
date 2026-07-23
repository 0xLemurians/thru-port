import assert from "node:assert/strict";
import test from "node:test";
import { TEMPLATES, getTemplate } from "../lib/templates";

test("all templates expose build-oriented metadata", () => {
  assert.equal(TEMPLATES.length, 4);
  for (const template of TEMPLATES) {
    assert.match(template.fileName, /\.c$/);
    assert.ok(template.accountDataBytes >= 0);
    assert.ok(template.instructionFormat.length > 0);
  }
});

test("stateful templates guard capacity and arithmetic overflow", () => {
  const counter = getTemplate("counter").source;
  const message = getTemplate("message_storage").source;
  const game = getTemplate("game_score").source;

  assert.match(counter, /count != ~0UL/);
  assert.match(message, /capacity >= sizeof\(ulong\)/);
  assert.match(game, /points <= ~0UL - score/);
});

test("unknown template ids fall back to the blank template", () => {
  assert.equal(getTemplate("unknown").id, "blank");
});
