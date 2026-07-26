import { createThruClient } from "@thru/sdk";

export const ALPHANET_RPC_URL = "https://rpc.alphanet.thru.org";

/**
 * The single browser-compatible SDK client used by AlphaNet reads and writes.
 * Private keys are never stored on this client or passed to its transport.
 */
export const thru = createThruClient({
  baseUrl: ALPHANET_RPC_URL,
});
