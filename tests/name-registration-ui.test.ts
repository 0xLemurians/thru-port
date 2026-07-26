import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { NameLookupSnapshot } from "../lib/thru/name-service/account-types";
import {
  ALPHANET_RPC_DEGRADED_MESSAGE,
  ALPHANET_RPC_UNAVAILABLE_MESSAGE,
} from "../lib/thru/name-service/constants";
import {
  PURCHASE_PROGRESS_STAGES,
  PurchaseError,
  type PurchaseDomainQuote,
  type PurchaseThruNameResult,
} from "../lib/thru/name-service/purchase";
import {
  REGISTRATION_AVAILABILITY_STATES,
  canRegisterName,
  checkRegistrationAvailability,
  closeRegistrationConfirmation,
  createInitialRegistrationUiState,
  createRegistrationConfirmation,
  registrationExplorerLinks,
  registrationFailureRequiresManualCheck,
  registrationFullName,
  registrationNetworkWarning,
  registrationPaymentMessage,
  registrationProgressState,
  resetRegistrationUiForLabel,
  safeRegistrationErrorMessage,
  validateRegistrationLabel,
} from "../components/name-studio/name-registration-state";
import {
  invokeNameLookupAction,
  nameLookupActionsDisabled,
} from "../components/name-studio/NameLookupForm";

const COMPONENT_SOURCE = readFileSync(
  join(
    process.cwd(),
    "components/name-studio/NameRegisterForm.tsx",
  ),
  "utf8",
);
const STUDIO_SOURCE = readFileSync(
  join(process.cwd(), "components/NameStudio.tsx"),
  "utf8",
);
const LOOKUP_FORM_SOURCE = readFileSync(
  join(
    process.cwd(),
    "components/name-studio/NameLookupForm.tsx",
  ),
  "utf8",
);
const GLOBAL_STYLES = readFileSync(
  join(process.cwd(), "app/globals.css"),
  "utf8",
);
const LOOKUP_RESULTS_SOURCE = [
  "components/name-studio/NameAccountDetails.tsx",
  "components/name-studio/LeaseDetails.tsx",
]
  .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
  .join("\n");

function readyQuote(
  overrides: Partial<PurchaseDomainQuote> = {},
): PurchaseDomainQuote {
  return {
    label: "Mert",
    years: 1,
    price: 123_456_789_012_345_678n,
    walletAddress: "wallet-address",
    configAddress: "config-address",
    leaseAddress: "lease-address",
    domainAddress: "domain-address",
    treasurerTokenAccount: "treasurer-address",
    payerTokenAccount: "payer-token-address",
    rootRegistrarAccount: "root-address",
    nameServiceProgram: "name-service-address",
    paymentMintAccount: "payment-mint-address",
    tokenProgram: "token-program-address",
    config: {
      nameServiceProgramId: "name-service-address",
      rootRegistrar: "root-address",
      treasurerTokenAccount: "treasurer-address",
      paymentMint: "payment-mint-address",
      tokenProgramId: "token-program-address",
      rootDomainName: "thru",
      pricePerYear: 123_456_789_012_345_678n,
      totalDomainsSold: 1n,
    },
    payment: { status: "ready" },
    ...overrides,
  };
}

function verifiedSnapshot(): NameLookupSnapshot {
  return {
    label: "Mert",
    fullyQualifiedName: "Mert.thru",
    configAddress: "config-address",
    domainAddress: "domain-address",
    leaseAddress: "lease-address",
    config: readyQuote().config,
    domain: {
      status: "found",
      address: "domain-address",
      state: {
        parent: "root-address",
        owner: "wallet-address",
        name: "Mert",
        registrationTime: 1n,
        recordCount: 0,
        records: [],
      },
    },
    lease: {
      status: "found",
      address: "lease-address",
      state: {
        domainAccount: "domain-address",
        owner: "wallet-address",
        domainName: "Mert",
        leaseStart: 1n,
        leaseEnd: 2n,
      },
    },
  };
}

test("registration input starts empty in the idle state", () => {
  const state = createInitialRegistrationUiState();
  assert.equal(state.labelInput, "");
  assert.equal(state.availability, "idle");
  assert.equal(state.quote, null);
});

test("the label input renders a separate visible .thru suffix", () => {
  assert.match(COMPONENT_SOURCE, /name-input-suffix/);
  assert.match(COMPONENT_SOURCE, />\s*\.thru\s*</);
});

test("the full-name preview updates from the trimmed label", () => {
  assert.equal(registrationFullName("  Mert  "), "Mert.thru");
  assert.equal(registrationFullName(""), ".thru");
});

test("registration rejects dots", () => {
  assert.throws(
    () => validateRegistrationLabel("mert.thru"),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "INVALID_LABEL",
  );
});

test("registration rejects a 65-byte label", () => {
  assert.throws(
    () => validateRegistrationLabel("x".repeat(65)),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "INVALID_LABEL",
  );
});

test("registration preserves case and Unicode without normalization", () => {
  assert.equal(validateRegistrationLabel("Mert"), "Mert");
  assert.notEqual(
    validateRegistrationLabel("Mert"),
    validateRegistrationLabel("mert"),
  );
  assert.equal(validateRegistrationLabel("\u00e9"), "\u00e9");
  assert.equal(validateRegistrationLabel("e\u0301"), "e\u0301");
  assert.notEqual(
    validateRegistrationLabel("\u00e9"),
    validateRegistrationLabel("e\u0301"),
  );
});

test("changing the label clears stale quote, confirmation, progress, and success", () => {
  const stale = {
    ...createInitialRegistrationUiState(),
    labelInput: "old",
    availability: "available" as const,
    quote: readyQuote(),
    confirmationOpen: true,
    progress: "submitting-transaction" as const,
    result: {
      signature: "signature",
      price: 1n,
      payerTokenAccountAddress: "payer",
      postState: verifiedSnapshot(),
    },
  };
  const cleared = resetRegistrationUiForLabel("new");
  assert.equal(stale.quote?.label, "Mert");
  assert.equal(cleared.labelInput, "new");
  assert.equal(cleared.availability, "idle");
  assert.equal(cleared.quote, null);
  assert.equal(cleared.confirmationOpen, false);
  assert.equal(cleared.progress, null);
  assert.equal(cleared.result, null);
});

test("an available mock result carries the exact quote", async () => {
  const quote = readyQuote();
  const result = await checkRegistrationAvailability(
    {
      labelInput: " Mert ",
      walletAddress: "wallet-address",
      networkStatus: "Online",
    },
    async (input) => {
      assert.equal(input.label, "Mert");
      assert.equal(input.years, 1);
      assert.equal(input.walletAddress, "wallet-address");
      return quote;
    },
  );
  assert.equal(result.status, "available");
  assert.equal(result.message, "Mert.thru is available");
  assert.equal(result.quote?.price, quote.price);
});

test("an existing name is reported as unavailable", async () => {
  const result = await checkRegistrationAvailability(
    {
      labelInput: "Mert",
      walletAddress: "wallet-address",
      networkStatus: "Online",
    },
    async () => {
      throw new PurchaseError("NAME_UNAVAILABLE", "existing");
    },
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.message, "Mert.thru is unavailable");
});

test("an expired existing name remains unavailable", async () => {
  const result = await checkRegistrationAvailability(
    {
      labelInput: "expired",
      walletAddress: "wallet-address",
      networkStatus: "Online",
    },
    async () => {
      throw new PurchaseError(
        "NAME_UNAVAILABLE",
        "expired names are unavailable",
      );
    },
  );
  assert.equal(result.status, "unavailable");
});

test("offline state prevents reads and disables registration", async () => {
  let quoteCalls = 0;
  const result = await checkRegistrationAvailability(
    {
      labelInput: "Mert",
      walletAddress: "wallet-address",
      networkStatus: "Offline",
    },
    async () => {
      quoteCalls += 1;
      return readyQuote();
    },
  );
  assert.equal(result.status, "rpc-offline");
  assert.equal(quoteCalls, 0);
  assert.equal(
    canRegisterName({
      walletActive: true,
      walletReady: true,
      availability: "available",
      quote: readyQuote(),
      purchasePending: false,
      networkStatus: "Offline",
    }),
    false,
  );
});

test("degraded state shows a warning while allowing a read attempt", async () => {
  assert.match(registrationNetworkWarning("Degraded") ?? "", /degraded/i);
  let quoteCalls = 0;
  const result = await checkRegistrationAvailability(
    {
      labelInput: "Mert",
      walletAddress: "wallet-address",
      networkStatus: "Degraded",
    },
    async () => {
      quoteCalls += 1;
      return readyQuote();
    },
  );
  assert.equal(result.status, "available");
  assert.equal(quoteCalls, 1);
});

test("raw upstream and transport failures are never rendered", () => {
  const identitySource =
    `${STUDIO_SOURCE}\n${LOOKUP_FORM_SOURCE}\n${LOOKUP_RESULTS_SOURCE}\n${COMPONENT_SOURCE}`;
  assert.doesNotMatch(
    identitySource,
    /upstream connect|disconnect\/reset|remote connection failure|connection refused/i,
  );
  assert.doesNotMatch(STUDIO_SOURCE, /caught\.message|error\.message/);
  assert.doesNotMatch(
    LOOKUP_RESULTS_SOURCE,
    /\{domain\.error\}|\{lease\.error\}/,
  );
  assert.equal(
    ALPHANET_RPC_UNAVAILABLE_MESSAGE,
    "AlphaNet RPC is currently unavailable. Try again later.",
  );
});

test("Identity renders the AlphaNet-unavailable notice without RPC errors", () => {
  assert.match(
    STUDIO_SOURCE,
    /\.thru registrations are not currently available on AlphaNet/,
  );
  assert.match(STUDIO_SOURCE, /announce on X when registration becomes available/);
  assert.doesNotMatch(STUDIO_SOURCE, /ALPHANET_RPC_UNAVAILABLE_MESSAGE/);
});

test("read-only lookup and Refresh actions are disabled while offline", () => {
  assert.equal(nameLookupActionsDisabled(false, "Offline"), true);
  assert.match(LOOKUP_FORM_SOURCE, /disabled=\{actionsDisabled\}/);
  assert.match(
    LOOKUP_FORM_SOURCE,
    /disabled=\{actionsDisabled \|\| !canRefresh\}/,
  );
});

test("an offline read-only form action performs no RPC callback", () => {
  let rpcCalls = 0;
  const invoked = invokeNameLookupAction(
    () => {
      rpcCalls += 1;
    },
    false,
    "Offline",
  );
  assert.equal(invoked, false);
  assert.equal(rpcCalls, 0);
});

test("the typed lookup label and preview remain visible while offline", () => {
  assert.match(LOOKUP_FORM_SOURCE, /value=\{label\}/);
  assert.match(
    LOOKUP_FORM_SOURCE,
    /Lookup: \{trimmedLabel \|\| "label"\}\.thru/,
  );
  assert.doesNotMatch(
    LOOKUP_FORM_SOURCE,
    /disabled=\{[^}]*networkStatus === "Offline"[^}]*\}/,
  );
});

test("degraded read-only lookup remains permitted with a warning", () => {
  let rpcCalls = 0;
  const invoked = invokeNameLookupAction(
    () => {
      rpcCalls += 1;
    },
    false,
    "Degraded",
  );
  assert.equal(invoked, true);
  assert.equal(rpcCalls, 1);
  assert.equal(
    nameLookupActionsDisabled(false, "Degraded"),
    false,
  );
  assert.match(ALPHANET_RPC_DEGRADED_MESSAGE, /degraded/i);
});

test("disabled registration and lookup buttons use neutral styling", () => {
  assert.match(COMPONENT_SOURCE, /className="btn btn-primary"/);
  assert.match(COMPONENT_SOURCE, /disabled=\{!registerEnabled\}/);
  assert.match(
    GLOBAL_STYLES,
    /\.name-register-actions \.btn:disabled[\s\S]*background: var\(--panel-strong\)/,
  );
  assert.match(
    GLOBAL_STYLES,
    /\.name-lookup-form \.name-lookup-action:disabled/,
  );
  assert.match(GLOBAL_STYLES, /cursor: not-allowed/);
  assert.match(GLOBAL_STYLES, /box-shadow: none/);
});

test("enabled Register retains the active orange primary styling", () => {
  assert.equal(
    canRegisterName({
      walletActive: true,
      walletReady: true,
      availability: "available",
      quote: readyQuote(),
      purchasePending: false,
      networkStatus: "Online",
    }),
    true,
  );
  assert.match(
    GLOBAL_STYLES,
    /\.btn-primary\s*\{[\s\S]*linear-gradient\(140deg, var\(--ember\)/,
  );
  assert.match(GLOBAL_STYLES, /\.btn-primary:hover:not\(:disabled\)/);
});

test("the registration card renders only one primary offline warning", () => {
  assert.equal(
    (
      COMPONENT_SOURCE.match(
        /name-network-message name-network-offline/g,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(
    COMPONENT_SOURCE,
    /No availability result is active/,
  );
});

test("offline registration state contains no stale availability result", () => {
  const state = resetRegistrationUiForLabel("Mert", true);
  assert.equal(state.availability, "rpc-offline");
  assert.equal(state.quote, null);
  assert.equal(state.confirmationOpen, false);
  assert.doesNotMatch(
    COMPONENT_SOURCE,
    /ui\.availability === "rpc-offline" && \(\s*<p/,
  );
});

test("one-year price display uses the exact BigInt raw amount", () => {
  const confirmation = createRegistrationConfirmation(readyQuote());
  assert.equal(confirmation.registrationPeriod, "1 year");
  assert.equal(
    confirmation.exactPrice,
    "123456789012345678 raw units",
  );
  assert.match(COMPONENT_SOURCE, /price\.toString\(\)/);
});

test("Register is disabled before an available quote", () => {
  assert.equal(
    canRegisterName({
      walletActive: true,
      walletReady: true,
      availability: "idle",
      quote: null,
      purchasePending: false,
      networkStatus: "Online",
    }),
    false,
  );
});

test("Register is disabled when the payment account is missing", () => {
  const quote = readyQuote({
    payment: {
      status: "missing",
      code: "PAYER_TOKEN_ACCOUNT_NOT_FOUND",
      message: "missing",
    },
  });
  assert.equal(
    canRegisterName({
      walletActive: true,
      walletReady: true,
      availability: "available",
      quote,
      purchasePending: false,
      networkStatus: "Online",
    }),
    false,
  );
  assert.match(registrationPaymentMessage(quote.payment) ?? "", /required/i);
});

test("Register is disabled when the payment balance is insufficient", () => {
  const quote = readyQuote({
    payment: {
      status: "insufficient",
      code: "INSUFFICIENT_PAYMENT_BALANCE",
      message: "insufficient",
    },
  });
  assert.equal(
    canRegisterName({
      walletActive: true,
      walletReady: true,
      availability: "available",
      quote,
      purchasePending: false,
      networkStatus: "Online",
    }),
    false,
  );
  assert.match(
    registrationPaymentMessage(quote.payment) ?? "",
    /insufficient/i,
  );
});

test("confirmation includes exact name, network, wallet, price, and payment account", () => {
  const confirmation = createRegistrationConfirmation(readyQuote());
  assert.deepEqual(confirmation, {
    fullName: "Mert.thru",
    network: "AlphaNet",
    registrationPeriod: "1 year",
    exactPrice: "123456789012345678 raw units",
    owner: "wallet-address",
    paymentTokenAccount: "payer-token-address",
    resetWarning: "AlphaNet may reset and remove this registration.",
    transactionWarning:
      "Confirming signs and submits an on-chain transaction.",
  });
});

test("Cancel only closes confirmation and performs no transaction action", () => {
  const open = {
    ...createInitialRegistrationUiState(),
    confirmationOpen: true,
    quote: readyQuote(),
  };
  const closed = closeRegistrationConfirmation(open);
  assert.equal(closed.confirmationOpen, false);
  assert.equal(closed.quote, open.quote);
  assert.equal(closed.purchasePending, false);
});

test("confirmation has no timeout or automatic close path", () => {
  assert.doesNotMatch(COMPONENT_SOURCE, /setTimeout|setInterval/);
  assert.match(COMPONENT_SOURCE, /Cancel/);
  assert.match(COMPONENT_SOURCE, /Confirm registration/);
});

test("the UI has synchronous double-click protection", () => {
  assert.match(
    COMPONENT_SOURCE,
    /if\s*\(\s*purchasePendingRef\.current/,
  );
  assert.match(COMPONENT_SOURCE, /purchasePendingRef\.current = true/);
  assert.match(COMPONENT_SOURCE, /disabled=\{ui\.purchasePending\}/);
});

test("progress stages use the verified engine order", () => {
  assert.deepEqual(PURCHASE_PROGRESS_STAGES, [
    "checking-availability",
    "refreshing-price",
    "validating-payment-account",
    "generating-state-proofs",
    "waiting-wallet-signature",
    "submitting-transaction",
    "confirming-transaction",
    "verifying-ownership",
  ]);
  assert.equal(
    registrationProgressState(
      "generating-state-proofs",
      "waiting-wallet-signature",
    ),
    "done",
  );
  assert.equal(
    registrationProgressState(
      "waiting-wallet-signature",
      "waiting-wallet-signature",
    ),
    "active",
  );
});

test("submission output alone is never rendered as success", () => {
  assert.match(COMPONENT_SOURCE, /const result = await purchaseThruName/);
  assert.match(COMPONENT_SOURCE, /result,\s*\}\)\);/);
  assert.doesNotMatch(COMPONENT_SOURCE, /setUi\([^)]*signature/);
});

test("owner mismatch maps to a safe verification failure", () => {
  const message = safeRegistrationErrorMessage(
    new PurchaseError("POST_STATE_MISMATCH", "owner secret detail"),
  );
  assert.match(message, /ownership could not be verified/i);
  assert.doesNotMatch(message, /secret detail/i);
});

test("verified ownership produces success Explorer links", () => {
  const result: PurchaseThruNameResult = {
    signature: "transaction-signature",
    price: 1n,
    payerTokenAccountAddress: "payer-token-address",
    postState: verifiedSnapshot(),
  };
  assert.deepEqual(registrationExplorerLinks(result), {
    domain: "https://scan.thru.org/address/domain-address",
    lease: "https://scan.thru.org/address/lease-address",
    transaction: "https://scan.thru.org/tx/transaction-signature",
  });
  assert.match(COMPONENT_SOURCE, /Registered to your wallet/);
});

test("Explorer links are created only through safe existing helpers", () => {
  const stateSource = readFileSync(
    join(
      process.cwd(),
      "components/name-studio/name-registration-state.ts",
    ),
    "utf8",
  );
  assert.match(stateSource, /nameExplorerAddressUrl/);
  assert.match(stateSource, /nameExplorerTransactionUrl/);
  assert.doesNotMatch(COMPONENT_SOURCE, /https:\/\/scan\.thru\.org/);
});

test("registration has no arbitrary owner input", () => {
  assert.doesNotMatch(COMPONENT_SOURCE, /name=["']owner/i);
  assert.match(COMPONENT_SOURCE, /purchaseThruName\(\s*account,/);
  assert.match(COMPONENT_SOURCE, /walletAddress: account\.address/);
});

test("first release exposes no transfer, reclaim, renewal, or advanced controls", () => {
  for (const forbidden of [
    "Transfer name",
    "Reclaim",
    "Renew",
    "Subdomain",
    "Edit records",
    "Auction",
    "Bulk register",
  ]) {
    assert.doesNotMatch(COMPONENT_SOURCE, new RegExp(forbidden, "i"));
  }
});

test("UI source never outputs secret, proof, or raw signed transaction material", () => {
  assert.doesNotMatch(
    COMPONENT_SOURCE,
    /privateKey|mnemonic|proof bytes|signed transaction bytes|toWire\(/i,
  );
});

test("registration adds no custom analytics events", () => {
  const stateSource = readFileSync(
    join(
      process.cwd(),
      "components/name-studio/name-registration-state.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    `${COMPONENT_SOURCE}\n${stateSource}`,
    /@vercel\/analytics|analytics\.|captureEvent|track\(/i,
  );
});

test("all explicit availability states are represented", () => {
  assert.deepEqual(REGISTRATION_AVAILABILITY_STATES, [
    "idle",
    "validating",
    "checking",
    "available",
    "unavailable",
    "rpc-offline",
    "error",
  ]);
});

test("uncertain post-submission failures block immediate retry", () => {
  assert.equal(
    registrationFailureRequiresManualCheck(
      new PurchaseError("TRANSACTION_TIMEOUT", "timeout"),
      "confirming-transaction",
    ),
    true,
  );
  assert.equal(
    registrationFailureRequiresManualCheck(
      new PurchaseError("OPERATION_ABORTED", "abort"),
      "generating-state-proofs",
    ),
    false,
  );
  assert.equal(
    registrationFailureRequiresManualCheck(
      new PurchaseError("OPERATION_ABORTED", "abort"),
      "submitting-transaction",
    ),
    true,
  );
});

test("uncertain registration shows only the safe message and public signature", () => {
  const message = safeRegistrationErrorMessage(
    new PurchaseError(
      "TRANSACTION_TIMEOUT",
      "upstream gRPC transport refused",
      "public-transaction-signature",
    ),
  );
  assert.match(message, /final confirmation is still unavailable/i);
  assert.match(message, /public-transaction-signature/);
  assert.doesNotMatch(message, /grpc|transport|refused/i);
});

test("disabled Identity exposes no registration or lookup request path", () => {
  assert.doesNotMatch(STUDIO_SOURCE, /<NameRegisterForm|<NameLookupForm/);
  assert.doesNotMatch(STUDIO_SOURCE, /lookupThruName|purchaseThruName/);
  assert.doesNotMatch(STUDIO_SOURCE, /Check Availability|Register|payment/i);
});
