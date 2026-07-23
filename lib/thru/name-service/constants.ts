export const ALPHANET_RPC_URL = "https://rpc.alphanet.thru.org";
export const ALPHANET_EXPLORER_ADDRESS_BASE_URL =
  "https://scan.thru.org/address";

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
export const LEASE_TIMESTAMP_WARNING =
  "Timestamp unit not officially verified.";

export const NAME_SECURITY_MESSAGES = [
  "Names are case-sensitive.",
  "Alice and alice derive different addresses.",
  "Unicode normalization is not applied.",
  "Visually similar Unicode characters may represent different names.",
] as const;

export function nameExplorerAddressUrl(address: string): string {
  return `${ALPHANET_EXPLORER_ADDRESS_BASE_URL}/${address}`;
}
