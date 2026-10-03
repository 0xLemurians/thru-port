"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PURCHASE_PROGRESS_STAGES,
  PurchaseError,
  purchaseThruName,
  type PurchaseProgressStage,
} from "@/lib/thru/name-service/purchase";
import { NETWORK_RPC_UNAVAILABLE_MESSAGE } from "@/lib/thru/name-service/constants";
import { utf8ByteLength } from "@/lib/thru/name-service/validation";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import type { NetworkHealth } from "../port/useNetworkHealth";
import { THRU_NETWORK } from "@/lib/thru/network";
import {
  REGISTRATION_PROGRESS_LABELS,
  canRegisterName,
  checkRegistrationAvailability,
  closeRegistrationConfirmation,
  createInitialRegistrationUiState,
  createRegistrationConfirmation,
  registrationExplorerLinks,
  registrationFailureRequiresManualCheck,
  registrationFullName,
  registrationNetworkWarning,
  registrationPaymentMessage,
  registrationProgressState,
  resetRegistrationUiForLabel,
  safeRegistrationErrorMessage,
  trimRegistrationLabel,
  validateRegistrationLabel,
} from "./name-registration-state";

interface NameRegisterFormProps {
  account: ThruAccount;
  health: NetworkHealth;
  walletReady: boolean;
}

function shortValue(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}...${value.slice(-10)}`;
}

export default function NameRegisterForm({
  account,
  health,
  walletReady,
}: NameRegisterFormProps) {
  const [ui, setUi] = useState(createInitialRegistrationUiState);
  const quoteControllerRef = useRef<AbortController | null>(null);
  const purchaseControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const purchasePendingRef = useRef(false);
  const lastProgressRef = useRef<PurchaseProgressStage | null>(null);
  const accountAddressRef = useRef(account.address);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const trimmedLabel = trimRegistrationLabel(ui.labelInput);
  const fullName = registrationFullName(ui.labelInput);
  const byteLength = utf8ByteLength(trimmedLabel);
  const networkWarning = registrationNetworkWarning(health.status);
  const primaryNetworkWarning =
    ui.availability === "rpc-offline"
      ? NETWORK_RPC_UNAVAILABLE_MESSAGE
      : networkWarning;
  const rpcUnavailable =
    health.status === "Offline" || ui.availability === "rpc-offline";
  const paymentMessage = ui.quote
    ? registrationPaymentMessage(ui.quote.payment)
    : null;
  const registerEnabled = canRegisterName({
    walletActive: true,
    walletReady,
    availability: ui.availability,
    quote: ui.quote,
    purchasePending: ui.purchasePending,
    networkStatus: health.status,
  });
  const confirmation = useMemo(
    () => (ui.quote ? createRegistrationConfirmation(ui.quote) : null),
    [ui.quote],
  );

  useEffect(
    () => () => {
      quoteControllerRef.current?.abort();
      purchaseControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (accountAddressRef.current === account.address) return;
    accountAddressRef.current = account.address;
    quoteControllerRef.current?.abort();
    requestSequenceRef.current += 1;
    purchasePendingRef.current = false;
    lastProgressRef.current = null;
    setUi(createInitialRegistrationUiState());
  }, [account.address]);

  useEffect(() => {
    if (health.status === "Offline") {
      quoteControllerRef.current?.abort();
      requestSequenceRef.current += 1;
      setUi((current) =>
        current.purchasePending
          ? current
          : {
              ...current,
              availability: "rpc-offline",
              quote: null,
              error: null,
              confirmationOpen: false,
            },
      );
    }
  }, [health.status]);

  useEffect(() => {
    if (ui.confirmationOpen && !ui.purchasePending) {
      cancelButtonRef.current?.focus();
    }
  }, [ui.confirmationOpen, ui.purchasePending]);

  useEffect(() => {
    if (!ui.confirmationOpen || ui.purchasePending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUi(closeRegistrationConfirmation);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ui.confirmationOpen, ui.purchasePending]);

  function changeLabel(value: string) {
    if (purchasePendingRef.current) return;
    quoteControllerRef.current?.abort();
    requestSequenceRef.current += 1;
    lastProgressRef.current = null;
    setUi(
      resetRegistrationUiForLabel(value, health.status === "Offline"),
    );
  }

  async function runAvailabilityCheck(openConfirmation: boolean) {
    if (
      purchasePendingRef.current ||
      ui.retryBlocked ||
      health.status === "Offline"
    ) {
      return;
    }

    quoteControllerRef.current?.abort();
    const controller = new AbortController();
    quoteControllerRef.current = controller;
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    setUi((current) => ({
      ...current,
      availability: "validating",
      quote: null,
      error: null,
      confirmationOpen: false,
      progress: null,
      result: null,
    }));

    try {
      validateRegistrationLabel(ui.labelInput);
    } catch (error) {
      if (requestSequenceRef.current !== sequence) return;
      setUi((current) => ({
        ...current,
        availability: "error",
        error: safeRegistrationErrorMessage(error),
      }));
      return;
    }

    setUi((current) => ({ ...current, availability: "checking" }));
    const result = await checkRegistrationAvailability({
      labelInput: ui.labelInput,
      walletAddress: account.address,
      networkStatus: health.status,
      signal: controller.signal,
    });
    if (
      controller.signal.aborted ||
      requestSequenceRef.current !== sequence
    ) {
      return;
    }

    if (result.status !== "available") {
      setUi((current) => ({
        ...current,
        availability: result.status,
        quote: null,
        error: result.status === "error" ? result.message : null,
        confirmationOpen: false,
      }));
      return;
    }

    const paymentError = registrationPaymentMessage(result.quote.payment);
    const canConfirm =
      result.quote.payment.status === "ready" &&
      walletReady;
    setUi((current) => ({
      ...current,
      availability: "available",
      quote: result.quote,
      error:
        paymentError ??
        (!walletReady
          ? "The active wallet must be saved or restored successfully before registration."
          : null),
      confirmationOpen: openConfirmation && canConfirm,
    }));
  }

  function cancelConfirmation() {
    if (purchasePendingRef.current) return;
    setUi(closeRegistrationConfirmation);
  }

  async function confirmRegistration() {
    const quote = ui.quote;
    if (
      purchasePendingRef.current ||
      !quote ||
      quote.payment.status !== "ready" ||
      !walletReady ||
      health.status === "Offline"
    ) {
      return;
    }

    purchasePendingRef.current = true;
    lastProgressRef.current = null;
    const controller = new AbortController();
    purchaseControllerRef.current = controller;
    setUi((current) => ({
      ...current,
      purchasePending: true,
      progress: null,
      error: null,
      result: null,
    }));

    try {
      const result = await purchaseThruName(
        account,
        {
          label: quote.label,
          years: 1,
          payerTokenAccountAddress: quote.payerTokenAccount,
        },
        {
          signal: controller.signal,
          onProgress: (stage) => {
            lastProgressRef.current = stage;
            setUi((current) => ({ ...current, progress: stage }));
          },
        },
      );
      setUi((current) => ({
        ...current,
        availability: "idle",
        quote: null,
        confirmationOpen: false,
        progress: null,
        purchasePending: false,
        retryBlocked: false,
        result,
      }));
    } catch (error) {
      const retryBlocked = registrationFailureRequiresManualCheck(
        error,
        lastProgressRef.current,
      );
      let availability: typeof ui.availability = "error";
      if (error instanceof PurchaseError) {
        if (error.code === "NAME_UNAVAILABLE") {
          availability = "unavailable";
        } else if (error.code === "RPC_UNAVAILABLE") {
          availability = "rpc-offline";
        }
      }
      setUi((current) => ({
        ...current,
        availability,
        quote: null,
        confirmationOpen: false,
        progress: null,
        purchasePending: false,
        retryBlocked,
        result: null,
        error: retryBlocked
          ? `${safeRegistrationErrorMessage(error)} Do not retry this name until its ${THRU_NETWORK.displayName} state is independently confirmed.`
          : safeRegistrationErrorMessage(error),
      }));
    } finally {
      purchasePendingRef.current = false;
      if (purchaseControllerRef.current === controller) {
        purchaseControllerRef.current = null;
      }
    }
  }

  const resultLinks = ui.result
    ? registrationExplorerLinks(ui.result)
    : null;
  const leaseEnd =
    ui.result?.postState.lease.status === "found"
      ? ui.result.postState.lease.state.leaseEnd
      : null;

  return (
    <section
      className="name-register-panel"
      aria-labelledby="name-register-title"
    >
      <div className="name-section-heading">
        <div>
          <p className="eyebrow token-eyebrow">Register a name</p>
          <h3 id="name-register-title">Claim a one-year .thru identity</h3>
        </div>
        <span className="workspace-nav-tag">{THRU_NETWORK.displayName.toUpperCase()}</span>
      </div>

      <p className="panel-sub">
        Registration is always owned and paid for by your current browser
        wallet.
      </p>

      {primaryNetworkWarning && (
        <p
          className={
            rpcUnavailable
              ? "name-network-message name-network-offline"
              : "name-network-message"
          }
          role="status"
        >
          {primaryNetworkWarning}
        </p>
      )}

      <form
        className="name-register-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runAvailabilityCheck(false);
        }}
      >
        <label className="form-field name-label-field">
          <span className="field-label">Label</span>
          <div className="name-input-wrap">
            <input
              className="input mono"
              type="text"
              value={ui.labelInput}
              onChange={(event) => changeLabel(event.target.value)}
              disabled={ui.purchasePending}
              placeholder="Enter label"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="register-label-help register-name-preview"
            />
            <span className="name-input-suffix" aria-hidden="true">
              .thru
            </span>
          </div>
          <span className="hint" id="register-label-help">
            Case and Unicode are preserved. Dots are not allowed. Maximum 64
            UTF-8 bytes.
          </span>
          <span
            className="name-label-preview mono"
            id="register-name-preview"
          >
            Preview: {fullName} · {byteLength}/64 UTF-8 bytes
          </span>
        </label>

        <div className="row name-register-actions">
          <button
            className="btn btn-ghost"
            type="submit"
            disabled={
              ui.purchasePending ||
              ui.retryBlocked ||
              health.status === "Offline" ||
              trimmedLabel.length === 0 ||
              ui.availability === "checking" ||
              ui.availability === "validating"
            }
          >
            {ui.availability === "checking"
              ? `Checking ${THRU_NETWORK.displayName}...`
              : ui.availability === "validating"
                ? "Validating..."
                : "Check availability"}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!registerEnabled}
            onClick={() => void runAvailabilityCheck(true)}
            aria-haspopup="dialog"
          >
            Register
          </button>
        </div>
      </form>

      {((ui.availability === "available" && ui.quote) ||
        ui.availability === "unavailable") && (
        <div className="name-availability" aria-live="polite">
          {ui.availability === "available" && ui.quote && (
          <div className="name-availability-card name-availability-available">
            <strong>{ui.quote.label}.thru is available</strong>
            <span>
              One year · Exact price:{" "}
              <code>{ui.quote.price.toString()} raw units</code>
            </span>
            <span>
              Owner:{" "}
              <code title={account.address}>{shortValue(account.address)}</code>
            </span>
            <details>
              <summary>Payment details</summary>
              <dl className="name-detail-grid">
                <div>
                  <dt>Payment mint</dt>
                  <dd className="mono">{ui.quote.paymentMintAccount}</dd>
                </div>
                <div>
                  <dt>Payment token account</dt>
                  <dd className="mono">{ui.quote.payerTokenAccount}</dd>
                </div>
                <div>
                  <dt>Exact raw price</dt>
                  <dd className="mono">{ui.quote.price.toString()}</dd>
                </div>
                <div>
                  <dt>Registration period</dt>
                  <dd>1 year</dd>
                </div>
              </dl>
            </details>
          </div>
          )}
          {ui.availability === "unavailable" && (
            <p className="name-availability-card name-availability-unavailable">
              <strong>{trimmedLabel}.thru is unavailable</strong>
            </p>
          )}
        </div>
      )}

      {(ui.error || paymentMessage) && (
        <p className="token-error" role="alert">
          {ui.error ?? paymentMessage}
        </p>
      )}

      {ui.result && resultLinks && (
        <section
          className="name-registration-success"
          aria-labelledby="name-registration-success-title"
        >
          <p className="eyebrow token-eyebrow">Ownership verified</p>
          <h3 id="name-registration-success-title">
            Registered to your wallet
          </h3>
          <dl className="name-detail-grid">
            <div>
              <dt>Name</dt>
              <dd className="mono">{ui.result.postState.fullyQualifiedName}</dd>
            </div>
            <div>
              <dt>Owner wallet</dt>
              <dd className="mono">{account.address}</dd>
            </div>
            {leaseEnd !== null && (
              <div>
                <dt>Lease end (raw)</dt>
                <dd className="mono">{leaseEnd.toString()}</dd>
              </div>
            )}
            <div>
              <dt>Transaction signature</dt>
              <dd className="mono">{ui.result.signature}</dd>
            </div>
          </dl>
          <div className="row">
            <a
              className="btn btn-ghost"
              href={resultLinks.domain}
              target="_blank"
              rel="noopener noreferrer"
            >
              Domain account
            </a>
            <a
              className="btn btn-ghost"
              href={resultLinks.lease}
              target="_blank"
              rel="noopener noreferrer"
            >
              Lease account
            </a>
            <a
              className="btn btn-ghost"
              href={resultLinks.transaction}
              target="_blank"
              rel="noopener noreferrer"
            >
              Transaction
            </a>
          </div>
        </section>
      )}

      {ui.confirmationOpen && confirmation && (
        <div className="name-confirmation-backdrop">
          <section
            className="name-confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="name-confirmation-title"
            aria-describedby="name-confirmation-warning"
          >
            <p className="eyebrow token-eyebrow">Confirm registration</p>
            <h3 id="name-confirmation-title">{confirmation.fullName}</h3>
            <dl className="name-confirmation-grid">
              <div>
                <dt>Network</dt>
                <dd>{confirmation.network}</dd>
              </div>
              <div>
                <dt>Registration period</dt>
                <dd>{confirmation.registrationPeriod}</dd>
              </div>
              <div>
                <dt>Exact price</dt>
                <dd className="mono">{confirmation.exactPrice}</dd>
              </div>
              <div>
                <dt>Owner wallet</dt>
                <dd className="mono">{confirmation.owner}</dd>
              </div>
              <div>
                <dt>Payment token account</dt>
                <dd className="mono">
                  {confirmation.paymentTokenAccount}
                </dd>
              </div>
            </dl>
            <div
              className="name-confirmation-warning"
              id="name-confirmation-warning"
            >
              <p>{confirmation.resetWarning}</p>
              <p>{confirmation.transactionWarning}</p>
            </div>

            {ui.purchasePending && (
              <ol
                className="token-progress name-registration-progress"
                aria-label="Name registration progress"
              >
                {PURCHASE_PROGRESS_STAGES.map((stage, index) => {
                  const state = registrationProgressState(
                    stage,
                    ui.progress,
                  );
                  return (
                    <li
                      className={`token-progress-item token-progress-${state}`}
                      key={stage}
                      aria-current={state === "active" ? "step" : undefined}
                    >
                      <span
                        className="token-progress-node"
                        aria-hidden="true"
                      >
                        {state === "done" ? "✓" : index + 1}
                      </span>
                      <span>{REGISTRATION_PROGRESS_LABELS[stage]}</span>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="row name-confirmation-actions">
              <button
                ref={cancelButtonRef}
                className="btn btn-ghost"
                type="button"
                disabled={ui.purchasePending}
                onClick={cancelConfirmation}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={ui.purchasePending}
                onClick={() => void confirmRegistration()}
              >
                {ui.purchasePending
                  ? ui.progress
                    ? REGISTRATION_PROGRESS_LABELS[ui.progress]
                    : "Preparing registration..."
                  : "Confirm registration"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
