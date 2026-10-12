# Native transfers: Phase 2C

Native sending is **disabled** in production by `NATIVE_SEND_ENABLED = false` in
`lib/wallet/native-transfer-controller.ts`. No environment variable enables it.
The provider independently checks the gate before crossing the signing boundary.
The native asset is visible for review of the raw-unit UI, but MAX/Review Send are
disabled. Existing token sending is unchanged.

After explicit approval for Phase 2D, run one isolated disposable-wallet smoke test
against the core (one submission, no retry) and verify its exact transaction body,
execution, journal recovery, Web Locks and Explorer result. Only after successful
QA and separate release approval may the constant be changed to `true`, with the
full regression suite and production build rerun. Do not enable it just to test UI.
Controller tests inject mocked execution and read dependencies instead.

Both surfaces consume one public wallet-scoped controller owned above navigation.
The confirmation dialog is shared and signs nothing when opened. Review performs
bounded read-only account/chain checks; the unchanged core repeats preflight before
signing. MAX includes the 1-unit fee and destination u64 capacity. Amounts and
balances remain integer native units, not a guessed THRU denomination.

Closing either send surface does not abort or erase the operation. Wallet-owner
unmount/switch stops observation; possibly submitted intents remain in the core's
network-scoped public journal. Reload hydrates that journal without signing or
submitting. Status refresh explicitly invokes read-only reconciliation; no retry
is offered for uncertain outcomes. Corrupt/denied storage fails closed.

The core has no progress callback. During its call the UI truthfully shows
“Submitting — awaiting verified result”; “Confirming” is used for explicit
read-only reconciliation, not inferred from elapsed time. A prepared journal
record is never represented as proof of broadcast or execution.
