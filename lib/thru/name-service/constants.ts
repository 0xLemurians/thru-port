export { ALPHANET_RPC_URL } from "../client";
export const ALPHANET_EXPLORER_ADDRESS_BASE_URL =
  "https://scan.thru.org/address";
export const ALPHANET_EXPLORER_TRANSACTION_BASE_URL =
  "https://scan.thru.org/tx";

/** Official AlphaNet base Name Service program from the Thru CLI defaults. */
export const NAME_SERVICE_PROGRAM_ADDRESS =
  "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF";

/** Official AlphaNet .thru Registrar program from the Thru CLI defaults. */
export const REGISTRAR_PROGRAM_ADDRESS =
  "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYG";

export const REGISTRAR_CONFIG_SEED_TEXT = "config";
export const LEASE_SEED_PREFIX = "lease:";

export const NAME_LABEL_MAX_UTF8_BYTES = 64;
export const NAME_RECORD_KEY_MAX_BYTES = 32;
export const NAME_RECORD_VALUE_MAX_BYTES = 256;

export const NAME_NOT_FOUND_MESSAGE =
  "Not found on the latest AlphaNet snapshot.";
export const NAME_SNAPSHOT_WARNING =
  "This is a snapshot only and does not reserve the name.";
export const NAME_DOMAIN_INVALID_MESSAGE =
  "The domain account data could not be verified safely.";
export const NAME_LEASE_INVALID_MESSAGE =
  "The lease account data could not be verified safely.";
export const LEASE_TIMESTAMP_WARNING =
  "Timestamp unit not officially verified.";
export const ALPHANET_RPC_UNAVAILABLE_MESSAGE =
  "AlphaNet RPC is currently unavailable. Try again later.";
export const ALPHANET_RPC_DEGRADED_MESSAGE =
  "AlphaNet RPC is degraded. Reads may fail, and final checks remain authoritative.";

export const NAME_SECURITY_MESSAGES = [
  "Names are case-sensitive.",
  "Alice and alice derive different addresses.",
  "Unicode normalization is not applied.",
  "Visually similar Unicode characters may represent different names.",
] as const;

export function nameExplorerAddressUrl(address: string): string {
  return `${ALPHANET_EXPLORER_ADDRESS_BASE_URL}/${address}`;
}

export function nameExplorerTransactionUrl(signature: string): string {
  return `${ALPHANET_EXPLORER_TRANSACTION_BASE_URL}/${signature}`;
}
