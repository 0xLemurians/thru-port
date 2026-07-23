"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatRawAmount } from "@thru/programs/token";
import {
  fetchTokenPortfolioOnAlphaNet,
  mintAdditionalSupplyOnAlphaNet,
  transferTokensOnAlphaNet,
  type CreateTokenResult,
  type TokenPortfolioItem,
} from "@/lib/token/thru-token";
import {
  LatestRequestTracker,
  loadKnownTokens,
  saveKnownTokens,
  upsertKnownToken,
  type KnownTokenRecord,
} from "@/lib/token/portfolio";
import {
  TOKEN_MUTATION_STAGES,
  TOKEN_MUTATION_STAGE_LABELS,
  type TokenMutationProgress,
  type TokenMutationStage,
} from "@/lib/token/workflow";
import {
  explorerAddressUrl,
  type ThruAccount,
} from "@/lib/wallet/thru-wallet";
import ResumeTokenSetup from "./ResumeTokenSetup";
import CreateDestinationTokenAccount from "./CreateDestinationTokenAccount";

interface TokenPortfolioProps {
  account: ThruAccount;
  createdToken: CreateTokenResult | null;
  onBusyChange?: (busy: boolean) => void;
}

type MutationKind = "mint-to" | "transfer";

export default function TokenPortfolio({
  account,
  createdToken,
  onBusyChange,
}: TokenPortfolioProps) {
  const [records, setRecords] = useState<KnownTokenRecord[]>([]);
  const [portfolio, setPortfolio] = useState<TokenPortfolioItem[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [manualLabel, setManualLabel] = useState("");
  const [manualMint, setManualMint] = useState("");
  const [manualTokenAccount, setManualTokenAccount] = useState("");

  const [mintToMint, setMintToMint] = useState("");
  const [mintToDestination, setMintToDestination] = useState("");
  const [mintToAmount, setMintToAmount] = useState("");
  const [transferSource, setTransferSource] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferAmount, setTransferAmount] = useState("");

  const [mutationKind, setMutationKind] = useState<MutationKind | null>(null);
  const [mutationProgress, setMutationProgress] =
    useState<TokenMutationProgress | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationSignature, setMutationSignature] = useState<string | null>(
    null,
  );
  const [mutationBusy, setMutationBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [destinationAccountBusy, setDestinationAccountBusy] = useState(false);

  const requestTrackerRef = useRef(new LatestRequestTracker());
  const mutationControllerRef = useRef<AbortController | null>(null);

  const refreshRecords = useCallback(async (next: KnownTokenRecord[]) => {
    const request = requestTrackerRef.current.begin();
    setRefreshing(true);
    setPortfolioError(null);
    try {
      const nextPortfolio = await fetchTokenPortfolioOnAlphaNet(next);
      if (!requestTrackerRef.current.isCurrent(request)) return;
      setPortfolio(nextPortfolio);
    } catch (error) {
      if (!requestTrackerRef.current.isCurrent(request)) return;
      setPortfolioError(
        error instanceof Error ? error.message : "Portfolio refresh failed.",
      );
    } finally {
      if (requestTrackerRef.current.isCurrent(request)) {
        setRefreshing(false);
      }
    }
  }, []);

  const persistAndRefresh = useCallback(
    (next: KnownTokenRecord[]) => {
      saveKnownTokens(window.localStorage, next);
      setRecords(next);
      void refreshRecords(next);
    },
    [refreshRecords],
  );

  useEffect(() => {
    const requestTracker = requestTrackerRef.current;
    const loaded = loadKnownTokens(window.localStorage);
    setRecords(loaded);
    setStorageReady(true);
    void refreshRecords(loaded);
    return () => {
      requestTracker.invalidate();
      mutationControllerRef.current?.abort();
    };
  }, [refreshRecords]);

  useEffect(() => {
    if (!storageReady || !createdToken) return;
    const next = upsertKnownToken(records, {
      mintAddress: createdToken.mintAddress,
      tokenAccountAddress: createdToken.tokenAccountAddress,
      label: createdToken.name,
    });
    if (JSON.stringify(next) === JSON.stringify(records)) return;
    persistAndRefresh(next);
  }, [createdToken, persistAndRefresh, records, storageReady]);

  const actionsBusy =
    mutationBusy || resumeBusy || destinationAccountBusy;

  useEffect(() => {
    onBusyChange?.(actionsBusy);
  }, [actionsBusy, onBusyChange]);

  const allAccounts = useMemo(
    () =>
      portfolio.flatMap((mintItem) =>
        mintItem.tokenAccounts
          .filter((entry) => entry.state && !entry.error)
          .map((entry) => ({
            address: entry.address,
            mintAddress: mintItem.mintAddress,
            mint: mintItem.mint,
            state: entry.state!,
          })),
      ),
    [portfolio],
  );

  const selectedMintToMint = portfolio.find(
    (item) => item.mintAddress === mintToMint,
  );
  const selectedMintToDestination = allAccounts.find(
    (item) => item.address === mintToDestination,
  );
  const mintToAllowed =
    Boolean(selectedMintToMint?.mint) &&
    selectedMintToMint?.mint?.mintAuthority === account.address &&
    selectedMintToDestination?.mintAddress === mintToMint &&
    !selectedMintToDestination?.state.isFrozen;

  const selectedTransferSource = allAccounts.find(
    (item) => item.address === transferSource,
  );
  const selectedTransferDestination = allAccounts.find(
    (item) => item.address === transferDestination,
  );
  const transferAllowed =
    Boolean(selectedTransferSource && selectedTransferDestination) &&
    transferSource !== transferDestination &&
    selectedTransferSource?.state.owner === account.address &&
    selectedTransferSource?.mintAddress ===
      selectedTransferDestination?.mintAddress &&
    !selectedTransferSource?.state.isFrozen &&
    !selectedTransferDestination?.state.isFrozen;

  function addKnownToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const next = upsertKnownToken(records, {
        mintAddress: manualMint,
        tokenAccountAddress: manualTokenAccount,
        label: manualLabel,
      });
      persistAndRefresh(next);
      setManualLabel("");
      setManualMint("");
      setManualTokenAccount("");
      setPortfolioError(null);
    } catch (error) {
      setPortfolioError(
        error instanceof Error ? error.message : "Could not add token.",
      );
    }
  }

  async function runMintTo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation("mint-to", (controller) =>
      mintAdditionalSupplyOnAlphaNet(
        account,
        {
          mintAddress: mintToMint,
          destinationAddress: mintToDestination,
          amount: mintToAmount,
        },
        {
          signal: controller.signal,
          onProgress: setMutationProgress,
        },
      ),
    );
  }

  async function runTransfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation("transfer", (controller) =>
      transferTokensOnAlphaNet(
        account,
        {
          sourceAddress: transferSource,
          destinationAddress: transferDestination,
          amount: transferAmount,
        },
        {
          signal: controller.signal,
          onProgress: setMutationProgress,
        },
      ),
    );
  }

  async function runMutation(
    kind: MutationKind,
    execute: (
      controller: AbortController,
    ) => Promise<{ signature: string }>,
  ) {
    const controller = new AbortController();
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = controller;
    setMutationKind(kind);
    setMutationProgress({ stage: "validating" });
    setMutationError(null);
    setMutationSignature(null);
    setMutationBusy(true);
    try {
      const result = await execute(controller);
      setMutationSignature(result.signature);
      await refreshRecords(records);
      if (kind === "mint-to") setMintToAmount("");
      if (kind === "transfer") setTransferAmount("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Token transaction failed.";
      setMutationError(
        controller.signal.aborted
          ? "Tracking was cancelled. A submitted transaction may still finalize; inspect its Explorer link before taking another action."
          : message,
      );
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
      }
      setMutationBusy(false);
    }
  }

  const handleResumeCompleted = useCallback(
    (result: {
      mintAddress: string;
      tokenAccountAddress: string;
    }) => {
      const existing = records.find(
        (record) => record.mintAddress === result.mintAddress,
      );
      const next = upsertKnownToken(records, {
        mintAddress: result.mintAddress,
        tokenAccountAddress: result.tokenAccountAddress,
        label: existing?.label,
      });
      persistAndRefresh(next);
    },
    [persistAndRefresh, records],
  );

  const handleDestinationAccountCompleted = useCallback(
    (result: {
      mintAddress: string;
      tokenAccountAddress: string;
    }) => {
      const existing = records.find(
        (record) => record.mintAddress === result.mintAddress,
      );
      const next = upsertKnownToken(records, {
        mintAddress: result.mintAddress,
        tokenAccountAddress: result.tokenAccountAddress,
        label: existing?.label,
      });
      persistAndRefresh(next);
    },
    [persistAndRefresh, records],
  );

  return (
    <section className="token-section" aria-labelledby="token-portfolio-title">
      <div className="token-section-header">
        <div>
          <p className="eyebrow token-eyebrow">Token Portfolio</p>
          <h3 id="token-portfolio-title">Known AlphaNet tokens</h3>
        </div>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={refreshing || actionsBusy}
          onClick={() => void refreshRecords(records)}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <p className="hint">
        Only public mint and token-account addresses are saved locally. Secret
        keys and recovery phrases are never stored.
      </p>

      <form className="portfolio-add-form" onSubmit={addKnownToken}>
        <label className="form-field">
          <span className="field-label">Studio label (optional)</span>
          <input
            className="input"
            value={manualLabel}
            onChange={(event) => setManualLabel(event.target.value)}
            placeholder="Treasury token"
            disabled={actionsBusy}
          />
        </label>
        <label className="form-field">
          <span className="field-label">Mint address</span>
          <input
            className="input mono"
            value={manualMint}
            onChange={(event) => setManualMint(event.target.value)}
            placeholder="ta..."
            spellCheck={false}
            autoComplete="off"
            disabled={actionsBusy}
          />
        </label>
        <label className="form-field">
          <span className="field-label">Token account (optional)</span>
          <input
            className="input mono"
            value={manualTokenAccount}
            onChange={(event) => setManualTokenAccount(event.target.value)}
            placeholder="ta..."
            spellCheck={false}
            autoComplete="off"
            disabled={actionsBusy}
          />
        </label>
        <button
          className="btn btn-ghost portfolio-add-button"
          type="submit"
          disabled={actionsBusy}
        >
          Add known token
        </button>
      </form>

      {portfolioError && <p className="error token-error">{portfolioError}</p>}

      {records.length === 0 && !refreshing ? (
        <div className="portfolio-empty">
          Create a token or add a known public mint address to begin.
        </div>
      ) : (
        <div className="portfolio-list">
          {portfolio.map((item) => (
            <PortfolioCard key={item.mintAddress} item={item} />
          ))}
        </div>
      )}

      <ResumeTokenSetup
        account={account}
        portfolio={portfolio}
        disabled={mutationBusy || destinationAccountBusy}
        onBusyChange={setResumeBusy}
        onCompleted={handleResumeCompleted}
      />

      <CreateDestinationTokenAccount
        account={account}
        portfolio={portfolio}
        disabled={mutationBusy || resumeBusy}
        onBusyChange={setDestinationAccountBusy}
        onCompleted={handleDestinationAccountCompleted}
      />

      <div className="token-actions-grid">
        <form className="token-action-card" onSubmit={runMintTo}>
          <div>
            <p className="eyebrow token-eyebrow">Additional supply</p>
            <h3>Mint more tokens</h3>
          </div>
          <label className="form-field">
            <span className="field-label">Mint</span>
            <select
              className="input mono"
              value={mintToMint}
              onChange={(event) => {
                setMintToMint(event.target.value);
                setMintToDestination("");
              }}
              disabled={actionsBusy}
            >
              <option value="">Select mint</option>
              {portfolio.map((item) => (
                <option key={item.mintAddress} value={item.mintAddress}>
                  {item.mint?.ticker ?? item.label ?? shortAddress(item.mintAddress)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span className="field-label">Destination token account</span>
            <select
              className="input mono"
              value={mintToDestination}
              onChange={(event) => setMintToDestination(event.target.value)}
              disabled={actionsBusy || !mintToMint}
            >
              <option value="">Select token account</option>
              {allAccounts
                .filter((entry) => entry.mintAddress === mintToMint)
                .map((entry) => (
                  <option key={entry.address} value={entry.address}>
                    {shortAddress(entry.address)}
                  </option>
                ))}
            </select>
          </label>
          <AmountField
            value={mintToAmount}
            onChange={setMintToAmount}
            disabled={actionsBusy}
          />
          {!mintToAllowed && mintToMint && (
            <p className="hint">
              The active wallet must be the mint authority and the destination
              must be a non-frozen account for this mint.
            </p>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={actionsBusy || !mintToAllowed || !mintToAmount.trim()}
          >
            Mint additional supply
          </button>
        </form>

        <form className="token-action-card" onSubmit={runTransfer}>
          <div>
            <p className="eyebrow token-eyebrow">Transfer</p>
            <h3>Move tokens</h3>
          </div>
          <label className="form-field">
            <span className="field-label">Source token account</span>
            <select
              className="input mono"
              value={transferSource}
              onChange={(event) => setTransferSource(event.target.value)}
              disabled={actionsBusy}
            >
              <option value="">Select source</option>
              {allAccounts.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.mint?.ticker ?? "TOKEN"} - {shortAddress(entry.address)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span className="field-label">Destination token account</span>
            <select
              className="input mono"
              value={transferDestination}
              onChange={(event) => setTransferDestination(event.target.value)}
              disabled={actionsBusy}
            >
              <option value="">Select destination</option>
              {allAccounts.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.mint?.ticker ?? "TOKEN"} - {shortAddress(entry.address)}
                </option>
              ))}
            </select>
          </label>
          <AmountField
            value={transferAmount}
            onChange={setTransferAmount}
            disabled={actionsBusy}
          />
          {!transferAllowed && transferSource && transferDestination && (
            <p className="hint">
              Source and destination must be different, non-frozen accounts for
              the same mint; the source must belong to the active wallet.
            </p>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={
              actionsBusy || !transferAllowed || !transferAmount.trim()
            }
          >
            Transfer tokens
          </button>
        </form>
      </div>

      {mutationProgress && (
        <div className="token-mutation-status">
          <div className="token-section-header">
            <h3>
              {mutationKind === "mint-to"
                ? "Additional supply transaction"
                : "Transfer transaction"}
            </h3>
            {mutationBusy && (
              <button
                className="btn btn-link"
                type="button"
                onClick={() => mutationControllerRef.current?.abort()}
              >
                Cancel tracking
              </button>
            )}
          </div>
          <MutationProgress progress={mutationProgress} />
          {(mutationSignature || mutationProgress.signature) && (
            <TransactionLink
              label={
                mutationKind === "mint-to"
                  ? "Additional supply"
                  : "Token transfer"
              }
              signature={
                mutationSignature ?? mutationProgress.signature ?? ""
              }
            />
          )}
          {mutationError && (
            <p
              className={
                mutationProgress.stage === "uncertain"
                  ? "token-uncertain-box"
                  : "error token-error"
              }
            >
              {mutationError}
              {mutationProgress.stage === "uncertain" &&
                mutationProgress.expectedStateObserved &&
                " The expected on-chain state was observed, but final consensus remains unconfirmed."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PortfolioCard({ item }: { item: TokenPortfolioItem }) {
  return (
    <article className="portfolio-card">
      <div className="portfolio-card-header">
        <div>
          <h3>{item.label || item.mint?.ticker || "Known token"}</h3>
          <code className="mono">{item.mintAddress}</code>
        </div>
        <ExplorerLink
          address={item.mintAddress}
          label="View mint on Explorer"
        />
      </div>

      {item.error ? (
        <p className="error token-error">{item.error}</p>
      ) : item.mint ? (
        <dl className="portfolio-details">
          <div>
            <dt>Ticker</dt>
            <dd className="mono">{item.mint.ticker}</dd>
          </div>
          <div>
            <dt>Decimals</dt>
            <dd>{item.mint.decimals}</dd>
          </div>
          <div>
            <dt>Supply</dt>
            <dd>
              {formatRawAmount(item.mint.supply, item.mint.decimals)}
              <span className="unit"> ({item.mint.supply.toString()} raw)</span>
            </dd>
          </div>
          <div>
            <dt>Freeze authority</dt>
            <dd>
              {item.mint.hasFreezeAuthority
                ? shortAddress(item.mint.freezeAuthority ?? "")
                : "None"}
            </dd>
          </div>
          <div className="portfolio-detail-wide">
            <dt>Mint authority</dt>
            <dd className="mono">{item.mint.mintAuthority}</dd>
          </div>
        </dl>
      ) : null}

      <div className="portfolio-accounts">
        <h4>Known token accounts</h4>
        {item.tokenAccounts.length === 0 ? (
          <p className="hint">No token account address has been added.</p>
        ) : (
          item.tokenAccounts.map((entry) => (
            <div className="portfolio-account" key={entry.address}>
              <div className="portfolio-account-header">
                <code className="mono">{entry.address}</code>
                <ExplorerLink
                  address={entry.address}
                  label="View token account on Explorer"
                />
              </div>
              {entry.error && <p className="error">{entry.error}</p>}
              {entry.state && (
                <dl className="portfolio-account-details">
                  <div>
                    <dt>Balance</dt>
                    <dd>
                      {item.mint
                        ? formatRawAmount(
                            entry.state.amount,
                            item.mint.decimals,
                          )
                        : entry.state.amount.toString()}
                      <span className="unit">
                        {" "}
                        ({entry.state.amount.toString()} raw)
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Frozen</dt>
                    <dd>{entry.state.isFrozen ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd className="mono">{entry.state.owner}</dd>
                  </div>
                  <div>
                    <dt>Mint</dt>
                    <dd className="mono">{entry.state.mint}</dd>
                  </div>
                </dl>
              )}
            </div>
          ))
        )}
      </div>
    </article>
  );
}

function AmountField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="form-field">
      <span className="field-label">Amount</span>
      <input
        className="input mono"
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="1.00"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
      <span className="hint">
        Plain decimal notation; converted to raw units with BigInt.
      </span>
    </label>
  );
}

function MutationProgress({ progress }: { progress: TokenMutationProgress }) {
  return (
    <ol className="token-progress" aria-label="Token transaction progress">
      {TOKEN_MUTATION_STAGES.map((stage, index) => {
        const state = mutationProgressState(stage, progress);
        return (
          <li
            key={stage}
            className={`token-progress-item token-progress-${state}`}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="token-progress-node" aria-hidden="true">
              {state === "done"
                ? "✓"
                : state === "failed"
                  ? "!"
                  : state === "uncertain"
                    ? "?"
                    : index + 1}
            </span>
            <span>{TOKEN_MUTATION_STAGE_LABELS[stage]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function mutationProgressState(
  stage: (typeof TOKEN_MUTATION_STAGES)[number],
  progress: TokenMutationProgress,
): "pending" | "active" | "done" | "failed" | "uncertain" {
  const stageIndex = TOKEN_MUTATION_STAGES.indexOf(stage);
  if (progress.stage === "failed") {
    const failedIndex = progress.failedAt
      ? TOKEN_MUTATION_STAGES.indexOf(progress.failedAt)
      : 0;
    if (stageIndex < failedIndex) return "done";
    if (stageIndex === failedIndex) return "failed";
    return "pending";
  }
  if (progress.stage === "uncertain") {
    const uncertainIndex = progress.uncertainAt
      ? TOKEN_MUTATION_STAGES.indexOf(progress.uncertainAt)
      : 0;
    if (stageIndex < uncertainIndex) return "done";
    if (stageIndex === uncertainIndex || stage === "completed") {
      return "uncertain";
    }
    return "pending";
  }
  const activeIndex = TOKEN_MUTATION_STAGES.indexOf(
    progress.stage as Exclude<TokenMutationStage, "failed" | "uncertain">,
  );
  if (progress.stage === "completed" || stageIndex < activeIndex) return "done";
  if (stageIndex === activeIndex) return "active";
  return "pending";
}

function ExplorerLink({
  address,
  label,
}: {
  address: string;
  label: string;
}) {
  return (
    <a
      className="icon-btn"
      href={explorerAddressUrl(address)}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
    >
      ↗
    </a>
  );
}

function TransactionLink({
  label,
  signature,
}: {
  label: string;
  signature: string;
}) {
  return (
    <a
      className="transaction-link"
      href={`https://scan.thru.org/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
      title={signature}
    >
      <span>{label}</span>
      <code className="mono">{shortAddress(signature)}</code>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}
