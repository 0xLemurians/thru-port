import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import type { TokenPortfolioHook } from "../token/portfolio-hook";
import { THRU_NETWORK } from "../thru/network";
import { buildWalletPortfolio, samePortfolioScope, unknownObservation,
  type PortfolioNetworkStatus, type TokenAsset, type WalletPortfolio } from "./asset-model";

export function portfolioViewKey(walletAddress?: string): string {
  return `${THRU_NETWORK.storageScope}:${walletAddress ?? "no-wallet"}`;
}

/** Legacy public consumers may project existing data, but never start a read here. */
export function portfolioForView(walletAddress: string, hook: TokenPortfolioHook,
  status: PortfolioNetworkStatus, balance: bigint | null, supplied?: WalletPortfolio | null): WalletPortfolio {
  const scope = { networkId: THRU_NETWORK.id, chainId: THRU_NETWORK.expectedChainId, walletAddress };
  if (supplied && samePortfolioScope(supplied.scope, scope)) return supplied;
  return buildWalletPortfolio({ scope, networkStatus: status, now: Date.now(),
    native: supplied ? null : { scope, observation: unknownObservation(),
      ...(balance === null ? { availability: "unavailable", rawBalance: null } as const
        : { availability: "available", rawBalance: balance } as const) },
    tokens: supplied ? null : hook.modelSnapshot ?? { scope, programAddress: BOOTSTRAP_PROGRAM_ADDRESSES.token,
      items: hook.portfolio, records: hook.records, discovery: hook.discovery ?? null } });
}

export function portfolioItemsForView(hook: TokenPortfolioHook, model: WalletPortfolio | null) {
  return model && !model.rejectedTokenSnapshot ? hook.portfolio.filter((item) =>
    item.walletAddress === model.scope.walletAddress && model.tokens.some((asset) => asset.mintAddress === item.mintAddress)) : [];
}

export function assetLabel(asset: TokenAsset): string {
  return asset.metadata.localLabel?.value ?? asset.metadata.ticker?.value ?? "Token reference";
}

export function observationTime(value: number | null): string {
  if (value === null) return "Unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "Unknown";
}

/** Mutually exclusive display groups; individual roles remain visible on every row. */
export function portfolioGroups(tokens: readonly TokenAsset[]) {
  const held = (asset: TokenAsset) => asset.relationships.walletOwned.status === "observed";
  const controlled = (asset: TokenAsset) => asset.relationships.creator.status === "observed" ||
    asset.relationships.mintAuthority.status === "observed";
  return [
    { title: "My Holdings", assets: tokens.filter(held) },
    { title: "Created / Controlled Tokens", assets: tokens.filter((asset) => !held(asset) && controlled(asset)) },
    { title: "Saved References", assets: tokens.filter((asset) => !held(asset) && !controlled(asset)) },
  ];
}
