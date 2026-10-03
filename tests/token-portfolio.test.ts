import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPortfolio,
  LatestRequestTracker,
  saveKnownTokens,
  type KnownTokenRecord,
} from "../lib/token/portfolio";
import {
  STALE_TOKEN_REFERENCE_MESSAGE,
  type TokenPortfolioItem,
} from "../lib/token/thru-token";

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

test("saved tokens from an unverifiable legacy program remain visible as stale", () => {
  const stale: TokenPortfolioItem = {
    mintAddress: VALID_ADDRESS,
    walletAddress: VALID_ADDRESS,
    error: STALE_TOKEN_REFERENCE_MESSAGE,
    tokenAccounts: [],
  };
  const classified = classifyPortfolio([stale], VALID_ADDRESS);
  assert.deepEqual(classified.activeAssets, [stale]);
  assert.deepEqual(classified.externalAssets, []);
  assert.match(stale.error ?? "", /unavailable|another network/i);
});
