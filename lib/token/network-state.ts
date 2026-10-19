import type { NetworkStatus } from "@/components/port/useNetworkHealth";
import {
  SAFE_TRANSACTION_UNCERTAIN_MESSAGE,
  SubmittedTransactionUncertainError,
} from "@/lib/thru/transactions";
import {
  NETWORK_RPC_DEGRADED_MESSAGE,
  NETWORK_RPC_UNAVAILABLE_MESSAGE,
} from "@/lib/thru/name-service/constants";

export function tokenNetworkWarning(
  status: NetworkStatus | undefined,
): string | null {
  if (status === "Offline") {
    return NETWORK_RPC_UNAVAILABLE_MESSAGE;
  }
  if (status === "Degraded") {
    return NETWORK_RPC_DEGRADED_MESSAGE;
  }
  return null;
}

export function tokenNetworkActionsDisabled(
  status: NetworkStatus | undefined,
): boolean {
  return status === "Offline";
}

export function tokenNetworkReadAllowed(
  status: NetworkStatus | undefined,
): boolean {
  return status !== "Offline";
}

export function invokeTokenNetworkAction(
  action: () => void,
  status: NetworkStatus | undefined,
): boolean {
  if (tokenNetworkActionsDisabled(status)) {
    return false;
  }
  action();
  return true;
}

export function safeTokenReadError(error: unknown): string | null {
  return error == null ? null : NETWORK_RPC_UNAVAILABLE_MESSAGE;
}

const UNSAFE_NETWORK_ERROR_PATTERN =
  /\b(?:rpc|grpc|proxy|upstream|transport|connection|connect|disconnect|reset|refused|unavailable|socket|headers?|status(?:\s+code)?|network|timeout|fetch)\b|https?:\/\/|\n\s+at\s+/i;

export function safeTokenActionError(
  error: unknown,
  fallback: string,
): string {
  // This known transaction outcome is not an untrusted transport diagnostic.
  // Never replace its no-retry warning with a generic availability message.
  if (error instanceof SubmittedTransactionUncertainError) {
    return SAFE_TRANSACTION_UNCERTAIN_MESSAGE;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  // The active transfer hook caches this exact safe text for wallet-scoped UI
  // restoration. Preserve it on the second sanitizer pass, but never whitelist
  // arbitrary errors merely containing some of the same words.
  if (message === SAFE_TRANSACTION_UNCERTAIN_MESSAGE) {
    return SAFE_TRANSACTION_UNCERTAIN_MESSAGE;
  }
  if (!message || UNSAFE_NETWORK_ERROR_PATTERN.test(message)) {
    return message
      ? NETWORK_RPC_UNAVAILABLE_MESSAGE
      : fallback;
  }
  return message;
}
