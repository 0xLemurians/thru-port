import type { NetworkStatus } from "../port/useAlphaNetHealth";
import {
  ALPHANET_RPC_DEGRADED_MESSAGE,
  ALPHANET_RPC_UNAVAILABLE_MESSAGE,
  nameExplorerAddressUrl,
  nameExplorerTransactionUrl,
} from "@/lib/thru/name-service/constants";
import {
  PurchaseError,
  PURCHASE_PROGRESS_STAGES,
  quotePurchaseDomain,
  validatePurchaseLabel,
  type PreparePurchaseDomainInput,
  type PurchaseDomainQuote,
  type PurchasePaymentReadiness,
  type PurchaseProgressStage,
  type PurchaseThruNameResult,
} from "@/lib/thru/name-service/purchase";

export const REGISTRATION_AVAILABILITY_STATES = [
  "idle",
  "validating",
  "checking",
  "available",
  "unavailable",
  "rpc-offline",
  "error",
] as const;

export type RegistrationAvailabilityStatus =
  (typeof REGISTRATION_AVAILABILITY_STATES)[number];

export interface RegistrationUiState {
  labelInput: string;
  availability: RegistrationAvailabilityStatus;
  quote: PurchaseDomainQuote | null;
  error: string | null;
  confirmationOpen: boolean;
  progress: PurchaseProgressStage | null;
  purchasePending: boolean;
  retryBlocked: boolean;
  result: PurchaseThruNameResult | null;
}

export function createInitialRegistrationUiState(): RegistrationUiState {
  return {
    labelInput: "",
    availability: "idle",
    quote: null,
    error: null,
    confirmationOpen: false,
    progress: null,
    purchasePending: false,
    retryBlocked: false,
    result: null,
  };
}

export function resetRegistrationUiForLabel(
  labelInput: string,
  rpcOffline = false,
): RegistrationUiState {
  return {
    ...createInitialRegistrationUiState(),
    labelInput,
    availability: rpcOffline ? "rpc-offline" : "idle",
  };
}

export function closeRegistrationConfirmation(
  state: RegistrationUiState,
): RegistrationUiState {
  if (state.purchasePending) return state;
  return { ...state, confirmationOpen: false };
}

export function trimRegistrationLabel(value: string): string {
  return value.trim();
}

export function registrationFullName(value: string): string {
  const label = trimRegistrationLabel(value);
  return label ? `${label}.thru` : ".thru";
}

export function validateRegistrationLabel(value: string): string {
  return validatePurchaseLabel(trimRegistrationLabel(value)).label;
}

export type RegistrationQuoteLoader = (
  input: PreparePurchaseDomainInput,
) => Promise<PurchaseDomainQuote>;

export type RegistrationCheckResult =
  | {
      status: "available";
      label: string;
      quote: PurchaseDomainQuote;
      message: string;
    }
  | {
      status: "unavailable" | "rpc-offline" | "error";
      label: string;
      quote: null;
      message: string;
    };

export async function checkRegistrationAvailability(
  input: {
    labelInput: string;
    walletAddress: string;
    networkStatus: NetworkStatus;
    signal?: AbortSignal;
  },
  loadQuote: RegistrationQuoteLoader = quotePurchaseDomain,
): Promise<RegistrationCheckResult> {
  const label = trimRegistrationLabel(input.labelInput);
  if (input.networkStatus === "Offline") {
    return {
      status: "rpc-offline",
      label,
      quote: null,
      message: ALPHANET_RPC_UNAVAILABLE_MESSAGE,
    };
  }

  try {
    const validLabel = validateRegistrationLabel(label);
    const quote = await loadQuote({
      label: validLabel,
      years: 1,
      walletAddress: input.walletAddress,
      signal: input.signal,
    });
    return {
      status: "available",
      label: validLabel,
      quote,
      message: `${validLabel}.thru is available`,
    };
  } catch (error) {
    if (error instanceof PurchaseError) {
      if (error.code === "NAME_UNAVAILABLE") {
        return {
          status: "unavailable",
          label,
          quote: null,
          message: `${label}.thru is unavailable`,
        };
      }
      if (error.code === "RPC_UNAVAILABLE") {
        return {
          status: "rpc-offline",
          label,
          quote: null,
          message: ALPHANET_RPC_UNAVAILABLE_MESSAGE,
        };
      }
    }
    return {
      status: "error",
      label,
      quote: null,
      message: safeRegistrationErrorMessage(error),
    };
  }
}

export function safeRegistrationErrorMessage(error: unknown): string {
  if (!(error instanceof PurchaseError)) {
    return "The registration request could not be completed safely.";
  }

  switch (error.code) {
    case "INVALID_LABEL":
      return "Enter a label with no dots and no more than 64 UTF-8 bytes.";
    case "INVALID_YEARS":
      return "The registration period is invalid.";
    case "NAME_UNAVAILABLE":
      return "This .thru name is unavailable.";
    case "RPC_UNAVAILABLE":
      return ALPHANET_RPC_UNAVAILABLE_MESSAGE;
    case "CONFIG_NOT_FOUND":
      return "The AlphaNet registrar configuration was not found.";
    case "CONFIG_INVALID":
      return "The AlphaNet registrar configuration is invalid.";
    case "PAYER_TOKEN_ACCOUNT_NOT_FOUND":
      return "Your wallet does not have the required payment token account.";
    case "PAYER_TOKEN_ACCOUNT_INVALID":
      return "Your wallet payment token account is not valid for this registration.";
    case "INSUFFICIENT_PAYMENT_BALANCE":
      return "Your wallet payment token balance is insufficient.";
    case "PROOF_GENERATION_FAILED":
      return "Fresh registration proofs could not be generated.";
    case "TRANSACTION_BUILD_FAILED":
      return "The registration transaction could not be prepared or signed.";
    case "TRANSACTION_REJECTED":
      return "The registration transaction was rejected.";
    case "TRANSACTION_TIMEOUT":
      return "The registration did not finish before the safety timeout.";
    case "POST_STATE_MISMATCH":
      return "Final ownership could not be verified for your wallet.";
    case "OPERATION_ABORTED":
      return "The registration request was cancelled.";
  }
}

export function registrationPaymentMessage(
  payment: PurchasePaymentReadiness,
): string | null {
  if (payment.status === "ready") return null;
  return safeRegistrationErrorMessage(
    new PurchaseError(payment.code, payment.message),
  );
}

export function canRegisterName(input: {
  walletActive: boolean;
  walletReady: boolean;
  availability: RegistrationAvailabilityStatus;
  quote: PurchaseDomainQuote | null;
  purchasePending: boolean;
  networkStatus: NetworkStatus;
}): boolean {
  return Boolean(
    input.walletActive &&
      input.walletReady &&
      input.availability === "available" &&
      input.quote?.payment.status === "ready" &&
      !input.purchasePending &&
      input.networkStatus !== "Offline",
  );
}

export interface RegistrationConfirmation {
  fullName: string;
  network: "AlphaNet";
  registrationPeriod: "1 year";
  exactPrice: string;
  owner: string;
  paymentTokenAccount: string;
  resetWarning: string;
  transactionWarning: string;
}

export function createRegistrationConfirmation(
  quote: PurchaseDomainQuote,
): RegistrationConfirmation {
  return {
    fullName: `${quote.label}.thru`,
    network: "AlphaNet",
    registrationPeriod: "1 year",
    exactPrice: `${quote.price.toString()} raw units`,
    owner: quote.walletAddress,
    paymentTokenAccount: quote.payerTokenAccount,
    resetWarning: "AlphaNet may reset and remove this registration.",
    transactionWarning:
      "Confirming signs and submits an on-chain transaction.",
  };
}

export const REGISTRATION_PROGRESS_LABELS: Record<
  PurchaseProgressStage,
  string
> = {
  "checking-availability": "Checking availability",
  "refreshing-price": "Refreshing price",
  "validating-payment-account": "Validating payment account",
  "generating-state-proofs": "Generating state proofs",
  "waiting-wallet-signature": "Waiting for wallet signature",
  "submitting-transaction": "Submitting transaction",
  "confirming-transaction": "Confirming transaction",
  "verifying-ownership": "Verifying ownership",
};

export function registrationProgressState(
  stage: PurchaseProgressStage,
  current: PurchaseProgressStage | null,
): "pending" | "active" | "done" {
  if (!current) return "pending";
  const stageIndex = PURCHASE_PROGRESS_STAGES.indexOf(stage);
  const currentIndex = PURCHASE_PROGRESS_STAGES.indexOf(current);
  if (stageIndex < currentIndex) return "done";
  if (stageIndex === currentIndex) return "active";
  return "pending";
}

export function registrationFailureRequiresManualCheck(
  error: unknown,
  progress: PurchaseProgressStage | null,
): boolean {
  if (!(error instanceof PurchaseError)) return false;
  if (
    error.code === "TRANSACTION_TIMEOUT" ||
    error.code === "POST_STATE_MISMATCH"
  ) {
    return true;
  }
  if (error.code !== "OPERATION_ABORTED" || !progress) return false;
  return (
    PURCHASE_PROGRESS_STAGES.indexOf(progress) >=
    PURCHASE_PROGRESS_STAGES.indexOf("submitting-transaction")
  );
}

export function registrationNetworkWarning(
  status: NetworkStatus,
): string | null {
  if (status === "Degraded") {
    return ALPHANET_RPC_DEGRADED_MESSAGE;
  }
  if (status === "Offline") {
    return ALPHANET_RPC_UNAVAILABLE_MESSAGE;
  }
  return null;
}

export function registrationExplorerLinks(result: PurchaseThruNameResult): {
  domain: string;
  lease: string;
  transaction: string;
} {
  return {
    domain: nameExplorerAddressUrl(result.postState.domainAddress),
    lease: nameExplorerAddressUrl(result.postState.leaseAddress),
    transaction: nameExplorerTransactionUrl(result.signature),
  };
}
