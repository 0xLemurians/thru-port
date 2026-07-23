import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestRequestTracker,
  saveKnownTokens,
  type KnownTokenRecord,
} from "../lib/token/portfolio";

const VALID_ADDRESS = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";

test("an older refresh response cannot overwrite newer portfolio state", async () => {
  const tracker = new LatestRequestTracker();
  let state = "initial";
  let releaseOld: (() => void) | undefined;

  const oldRequest = tracker.begin();
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  }).then(() => {
    if (tracker.isCurrent(oldRequest)) state = "old";
  });

  const newRequest = tracker.begin();
  if (tracker.isCurrent(newRequest)) state = "new";
  releaseOld?.();
  await oldResponse;

  assert.equal(state, "new");
  assert.equal(tracker.isCurrent(oldRequest), false);
  assert.equal(tracker.isCurrent(newRequest), true);
});

test("portfolio persistence strips fields other than public references and label", () => {
  let stored = "";
  const record = {
    mintAddress: VALID_ADDRESS,
    label: "Public label",
    tokenAccountAddresses: [VALID_ADDRESS],
    privateKey: "must-not-persist",
    mnemonic: "must-not-persist",
  } as KnownTokenRecord;

  saveKnownTokens(
    {
      setItem: (_key, value) => {
        stored = value;
      },
    },
    [record],
  );

  assert.deepEqual(JSON.parse(stored), [
    {
      mintAddress: VALID_ADDRESS,
      label: "Public label",
      tokenAccountAddresses: [VALID_ADDRESS],
    },
  ]);
  assert.doesNotMatch(stored, /privateKey|mnemonic|must-not-persist/);
});
