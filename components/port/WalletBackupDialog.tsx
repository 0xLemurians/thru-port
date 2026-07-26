"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ThruAccount } from "@/lib/wallet/thru-wallet";
import {
  BACKUP_ACKNOWLEDGEMENT_MESSAGE,
  BACKUP_PASSWORD_MISMATCH_MESSAGE,
  BACKUP_PASSWORD_TOO_SHORT_MESSAGE,
  WalletBackupError,
  clearSecretInputs,
  downloadEncryptedWalletBackup,
  validateBackupExportRequirements,
  validateBackupPassword,
} from "@/lib/wallet/wallet-backup";
import { loadCreatedTokensForWallet } from "@/lib/token/portfolio";

interface WalletBackupDialogProps {
  account: ThruAccount;
  onClose: () => void;
  onExported?: () => void;
}

export default function WalletBackupDialog({
  account,
  onClose,
  onExported,
}: WalletBackupDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordIssue, setPasswordIssue] = useState<string | null>(null);
  const [confirmationIssue, setConfirmationIssue] = useState<string | null>(
    null,
  );
  const [passwordValid, setPasswordValid] = useState(false);
  const [confirmationMatches, setConfirmationMatches] = useState(false);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const warningId = `${idPrefix}-warning`;
  const passwordId = `${idPrefix}-password`;
  const confirmationId = `${idPrefix}-confirmation`;
  const passwordHelpId = `${idPrefix}-password-help`;
  const confirmationIssueId = `${idPrefix}-confirmation-issue`;
  const acknowledgementIssueId = `${idPrefix}-acknowledgement-issue`;

  const clearPasswordControls = useCallback(() => {
    clearSecretInputs(passwordRef.current, confirmationRef.current);
  }, []);

  const resetForm = useCallback(() => {
    clearPasswordControls();
    setAcknowledged(false);
    setError(null);
    setPasswordIssue(null);
    setConfirmationIssue(null);
    setPasswordValid(false);
    setConfirmationMatches(false);
  }, [clearPasswordControls]);

  useEffect(() => {
    resetForm();
    passwordRef.current?.focus();
    return clearPasswordControls;
  }, [account.address, clearPasswordControls, resetForm]);

  const refreshValidation = () => {
    const password = passwordRef.current?.value ?? "";
    const confirmation = confirmationRef.current?.value ?? "";
    const validation = validateBackupPassword(password);
    const matches = confirmation.length > 0 && password === confirmation;

    setPasswordValid(validation.valid);
    setConfirmationMatches(matches);
    setPasswordIssue(
      password.length > 0 && !validation.valid ? validation.message : null,
    );
    setConfirmationIssue(
      confirmation.length > 0 && !matches
        ? BACKUP_PASSWORD_MISMATCH_MESSAGE
        : null,
    );
    setError(null);
  };

  const close = () => {
    if (pendingRef.current) return;
    resetForm();
    onClose();
  };

  const exportBackup = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingRef.current) return;

    let password = passwordRef.current?.value ?? "";
    let confirmation = confirmationRef.current?.value ?? "";
    const requirements = validateBackupExportRequirements(
      password,
      confirmation,
      acknowledged,
    );
    if (!requirements.valid) {
      resetForm();
      password = "";
      confirmation = "";
      setError(requirements.message);
      passwordRef.current?.focus();
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const createdTokens = loadCreatedTokensForWallet(
        window.localStorage,
        account.address,
      );
      await downloadEncryptedWalletBackup(account, password, {
        createdTokens,
      });
      resetForm();
      onExported?.();
      onClose();
    } catch (caught) {
      resetForm();
      setError(
        caught instanceof WalletBackupError
          ? caught.message
          : "Unable to create the encrypted wallet backup. Try again.",
      );
      passwordRef.current?.focus();
    } finally {
      password = "";
      confirmation = "";
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "rgba(12, 7, 9, 0.76)",
        backdropFilter: "blur(8px)",
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={warningId}
        onSubmit={exportBackup}
        style={{
          width: "min(100%, 480px)",
          padding: 24,
          borderRadius: 12,
          border: "1px solid rgba(255, 226, 210, 0.17)",
          background: "#26181D",
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
        }}
      >
        <h2
          id={titleId}
          style={{ margin: "0 0 8px", color: "#FFF9F5", fontSize: 20 }}
        >
          Create wallet JSON backup
        </h2>
        <p
          id={warningId}
          role="alert"
          style={{
            margin: "0 0 18px",
            padding: "14px 16px",
            borderRadius: 10,
            border: "1px solid rgba(255, 113, 89, 0.45)",
            background:
              "linear-gradient(135deg, rgba(196, 57, 38, 0.18), rgba(244, 122, 60, 0.08))",
            color: "#FFD5CA",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          This JSON file contains your private key in plain text. Anyone with
          access to this file can control your wallet. Store it securely and
          never share it. The backup password protects the encrypted payload,
          but it does not protect the visible plaintext privateKey field.
        </p>

        <label className="pc-label" htmlFor={passwordId}>
          Backup password
        </label>
        <input
          ref={passwordRef}
          id={passwordId}
          className="pc-input"
          type="password"
          autoComplete="new-password"
          disabled={pending}
          maxLength={2048}
          aria-describedby={passwordHelpId}
          aria-invalid={Boolean(passwordIssue)}
          onChange={refreshValidation}
          style={{ marginBottom: 6 }}
        />
        <p
          id={passwordHelpId}
          style={{
            margin: "0 0 12px",
            color: passwordIssue ? "#ff8d8d" : "#CEBAB0",
            fontSize: 12,
          }}
        >
          {passwordIssue ?? BACKUP_PASSWORD_TOO_SHORT_MESSAGE}
        </p>

        <label className="pc-label" htmlFor={confirmationId}>
          Confirm backup password
        </label>
        <input
          ref={confirmationRef}
          id={confirmationId}
          className="pc-input"
          type="password"
          autoComplete="new-password"
          disabled={pending}
          maxLength={2048}
          aria-describedby={
            confirmationIssue ? confirmationIssueId : undefined
          }
          aria-invalid={Boolean(confirmationIssue)}
          onChange={refreshValidation}
          style={{ marginBottom: confirmationIssue ? 6 : 16 }}
        />
        {confirmationIssue && (
          <p
            id={confirmationIssueId}
            style={{
              margin: "0 0 12px",
              color: "#ff8d8d",
              fontSize: 12,
            }}
          >
            {confirmationIssue}
          </p>
        )}

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            color: "#CEBAB0",
            fontSize: 12,
            lineHeight: 1.5,
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={pending}
            aria-describedby={
              passwordValid && confirmationMatches && !acknowledged
                ? acknowledgementIssueId
                : undefined
            }
            onChange={(event) => {
              setAcknowledged(event.target.checked);
              setError(null);
            }}
            style={{ marginTop: 2 }}
          />
          <span>
            I understand that the privateKey field is visible in plain text
            and is not protected by the backup password.
          </span>
        </label>
        {passwordValid && confirmationMatches && !acknowledged && (
          <p
            id={acknowledgementIssueId}
            style={{
              margin: "8px 0 0",
              color: "#ff8d8d",
              fontSize: 12,
            }}
          >
            {BACKUP_ACKNOWLEDGEMENT_MESSAGE}
          </p>
        )}

        {error && (
          <p
            role="alert"
            style={{
              margin: "14px 0 0",
              color: "#ff8d8d",
              fontSize: 12,
            }}
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
          }}
        >
          <button
            type="button"
            className="pc-btn-secondary"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="pc-btn-primary"
            disabled={
              pending ||
              !passwordValid ||
              !confirmationMatches ||
              !acknowledged
            }
          >
            {pending ? "Encrypting..." : "Download JSON backup"}
          </button>
        </div>
      </form>
    </div>
  );
}
