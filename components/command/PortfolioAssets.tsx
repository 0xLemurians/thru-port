"use client";

import React from "react";
import { explorerAddressUrl } from "@/lib/thru/network";
import { nativeBalanceDisplay, tokenSourceDisplay, type NativeAsset, type TokenAsset,
  type Observation, type Freshness, type WalletPortfolio } from "@/lib/portfolio/asset-model";
import { assetLabel, observationTime, portfolioGroups } from "@/lib/portfolio/presentation";
import styles from "./command.module.css";

export function ObservationStatus({ observation, freshness }: { observation: Observation; freshness: Freshness }) {
  return <span className={styles.assetNote}>
    {observation.source === "cache" ? "Cached public observation" : observation.source === "rpc" ? "RPC observation" : "Provenance unknown"}
    {" · "}{freshness === "fresh" ? "Fresh observation" : freshness === "stale" ? "Stale" : "Freshness unknown"}
    {" · "}{observation.finality === "authoritative" ? "Authoritative account observation" :
      observation.finality === "provisional" ? "Provisional — not finalized" : "Finality unknown"}
  </span>;
}

export function NativeAssetSummary({ asset }: { asset: NativeAsset }) {
  return <div className={styles.assetRow} aria-label="Native asset">
    <strong>Native balance</strong>
    <span className={styles.assetAmount}>{nativeBalanceDisplay(asset)}</span>
    <ObservationStatus observation={asset.observation} freshness={asset.freshness} />
  </div>;
}

export function TokenAssetSummary({ asset }: { asset: TokenAsset }) {
  return <>
    <strong className={styles.assetAmount}>{assetLabel(asset)}</strong>
    {asset.metadata.localLabel && <span className={styles.assetNote}>Local label</span>}
    <span className={styles.assetNote}>{asset.metadata.ticker?.value ?? "Ticker unknown"} · Mint: {asset.mintAddress}</span>
    <span className={styles.assetNote}>
      {asset.relationships.walletOwned.status === "observed" ? "Wallet-owned account observed" : "Ownership not confirmed"}
      {asset.relationships.creator.status === "observed" ? " · Creator" : ""}
      {asset.relationships.mintAuthority.status === "observed" ? " · Mint authority" : ""}
      {asset.relationships.savedReference ? " · Saved locally" : ""}
    </span>
    <span className={styles.assetAmount}>{asset.sources.length === 1 ? `Observed balance: ${tokenSourceDisplay(asset, asset.sources[0])}` :
      asset.sources.length > 1 ? `${asset.sources.length} source accounts — balances shown separately` : "Balance unavailable"}</span>
    <ObservationStatus observation={asset.observation} freshness={asset.freshness} />
  </>;
}

export function TokenAccountDetails({ asset }: { asset: TokenAsset }) {
  return <details className={styles.assetDetails}>
    <summary>Account details ({asset.sources.length})</summary>
    <a href={explorerAddressUrl(asset.mintAddress)} target="_blank" rel="noopener noreferrer">Mint: {asset.mintAddress}</a>
    {asset.sources.length === 0 && <p>No verified source account in this snapshot.</p>}
    {asset.sources.map((source) => <div className={styles.assetSource} key={source.address}>
      <a href={explorerAddressUrl(source.address)} target="_blank" rel="noopener noreferrer">Account: {source.address}</a>
      <span>Mint: {source.decodedMintAddress ?? "Unknown"}</span>
      <span>Owner: {source.decodedOwner ?? "Unknown"}</span>
      <span className={styles.assetAmount}>Observed balance: {tokenSourceDisplay(asset, source)}</span>
      <ObservationStatus observation={source.observation} freshness={source.freshness} />
      <span className={styles.assetNote}>Observed at: {observationTime(source.observation.observedAt)}</span>
      <span className={styles.assetNote}>Version slot: {source.observation.version?.slot ?? "Unknown"} · Consensus: {source.observation.consensus ?? "Unknown"}</span>
      {source.frozen === true && <span className={styles.assetWarning}>Frozen account</span>}
      {source.availability === "unavailable" && <span className={styles.assetWarning}>Account data unavailable</span>}
      {source.error && <span className={styles.assetWarning}>{source.error}</span>}
      <span className={styles.assetNote}>{source.eligibility.kind === "blocked"
        ? `Not a Send candidate: ${source.eligibility.reason.replaceAll("-", " ")}.`
        : "Candidate only — Send still requires current on-chain preflight."}</span>
    </div>)}
    <p className={styles.assetNote}>Observed holdings are not proof of spendability. No balances are combined for Send or MAX.</p>
  </details>;
}

export function PortfolioAssetList({ model, onSelect, disabled = false }: {
  model: WalletPortfolio; onSelect?: (mint: string) => void; disabled?: boolean;
}) {
  return <div className={styles.assetList}>
    {model.tokens.length === 0 && <p className={styles.assetNote}>No holdings or saved references in this wallet/network snapshot. Discovery may be incomplete.</p>}
    {portfolioGroups(model.tokens).map((group) => <section key={group.title} aria-label={group.title}>
      <h5 className={styles.assetGroupTitle}>{group.title}</h5>
      {group.assets.map((asset) => <div className={styles.assetRow} key={asset.id}>
        {onSelect ? <button type="button" className={styles.assetSelect} disabled={disabled} onClick={() => onSelect(asset.mintAddress)}>
          <TokenAssetSummary asset={asset} />
        </button> : <TokenAssetSummary asset={asset} />}
        <TokenAccountDetails asset={asset} />
      </div>)}
    </section>)}
  </div>;
}
