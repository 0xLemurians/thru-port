import {
  createThruClient,
  TransactionSigningScheme,
} from "@thru/sdk";
import { THRU_NETWORK } from "./network";

export const THRU_RPC_URL = THRU_NETWORK.rpcUrl;

/**
 * The single browser-compatible SDK client used by Betanet reads and writes.
 * Private keys are never stored on this client or passed to its transport.
 */
export const thru = createThruClient({
  baseUrl: THRU_RPC_URL,
  transactionSigningScheme: TransactionSigningScheme.Rfc8032,
});
