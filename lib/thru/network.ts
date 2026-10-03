export interface ThruNetworkDescriptor {
  readonly id: "betanet";
  readonly displayName: "Betanet";
  readonly rpcUrl: string;
  readonly expectedChainId: number;
  readonly explorerBaseUrl: string;
  readonly explorerQuery: string;
  readonly storageScope: string;
}

/**
 * The single production network used by Thru Port.
 *
 * `expectedChainId` is a fail-closed network identity check only. Write
 * transactions must still obtain their actual chain ID from the live RPC
 * while the SDK builds the transaction.
 */
export const THRU_NETWORK: ThruNetworkDescriptor = Object.freeze({
  id: "betanet",
  displayName: "Betanet",
  rpcUrl: "https://rpc.betanet.thru.org",
  expectedChainId: 2,
  explorerBaseUrl: "https://scan.thru.org",
  explorerQuery: "network=betanet",
  storageScope: "betanet:2",
});

export const NETWORK_RPC_UNAVAILABLE_MESSAGE =
  `${THRU_NETWORK.displayName} RPC is currently unavailable. Try again later.`;
export const NETWORK_RPC_DEGRADED_MESSAGE =
  `${THRU_NETWORK.displayName} RPC is degraded. Reads may fail, and final checks remain authoritative.`;

function explorerPathUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${THRU_NETWORK.explorerBaseUrl}${normalizedPath}?${THRU_NETWORK.explorerQuery}`;
}

export function explorerHomeUrl(): string {
  return `${THRU_NETWORK.explorerBaseUrl}/?${THRU_NETWORK.explorerQuery}`;
}

export function explorerAddressUrl(address: string): string {
  return explorerPathUrl(`/address/${encodeURIComponent(address)}`);
}

export function explorerTransactionUrl(signature: string): string {
  return explorerPathUrl(`/tx/${encodeURIComponent(signature)}`);
}

export function networkStorageKey(namespace: string, version: number): string {
  if (!/^[a-z][a-z0-9.]*$/i.test(namespace)) {
    throw new Error("A safe storage namespace is required.");
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("A positive storage schema version is required.");
  }
  return `${namespace}.${THRU_NETWORK.storageScope}.v${version}`;
}
