import type { NetworkStatus } from "@/lib/network/alphanet-health";
import { SAFE_TRANSACTION_UNCERTAIN_MESSAGE } from "@/lib/thru/transactions";

export const SAFE_FAUCET_ERROR_MESSAGE =
  "The faucet request could not be completed. Try again when AlphaNet is available.";
export const SAFE_FAUCET_UNAVAILABLE_MESSAGE =
  "The AlphaNet faucet is not available on this deployment.";
export const SAFE_FAUCET_UNCERTAIN_MESSAGE =
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE;

export function safeFaucetDisplayMessage(error: unknown): string {
  if (error === SAFE_FAUCET_UNCERTAIN_MESSAGE) {
    return SAFE_FAUCET_UNCERTAIN_MESSAGE;
  }
  if (error === SAFE_FAUCET_UNAVAILABLE_MESSAGE) {
    return SAFE_FAUCET_UNAVAILABLE_MESSAGE;
  }
  return SAFE_FAUCET_ERROR_MESSAGE;
}

export function faucetFailureRequiresManualCheck(error: unknown): boolean {
  return (
    error === SAFE_FAUCET_UNCERTAIN_MESSAGE ||
    error === SAFE_FAUCET_UNAVAILABLE_MESSAGE
  );
}

export type FaucetUiState =
  | "idle"
  | "requesting"
  | "confirming"
  | "success"
  | "error";

export function isFaucetActionDisabled(
  networkStatus: NetworkStatus,
  faucetState: FaucetUiState,
): boolean {
  return networkStatus !== "Online" || faucetState === "requesting";
}
