import type { NetworkStatus } from "@/lib/network/alphanet-health";

export const SAFE_FAUCET_ERROR_MESSAGE =
  "The faucet request could not be completed. Try again when AlphaNet is available.";

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
