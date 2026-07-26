import { bytesToHex } from "./thru-wallet";

export const PRIVATE_KEY_AUTO_HIDE_MS = 30_000;
export const PRIVATE_KEY_COPY_STATUS_MS = 2_000;
export const PRIVATE_KEY_MASK = "•".repeat(64);
export const PRIVATE_KEY_COPY_SUCCESS_MESSAGE = "Private key copied";
export const PRIVATE_KEY_COPY_ERROR_MESSAGE =
  "Unable to copy the private key. Copy it manually.";

export type WalletActivationSource =
  | "created"
  | "restored"
  | "mnemonic-import"
  | "private-key-import"
  | "encrypted-backup-import";

export interface OneTimePrivateKeyBackupState {
  revealed: boolean;
  acknowledged: boolean;
  dismissed: boolean;
  copyStatus: "idle" | "copied" | "error";
}

export type OneTimePrivateKeyBackupAction =
  | { type: "show" }
  | { type: "hide" }
  | { type: "acknowledge"; value: boolean }
  | { type: "copy-succeeded" }
  | { type: "copy-failed" }
  | { type: "clear-copy-status" }
  | { type: "continue" };

export const INITIAL_ONE_TIME_PRIVATE_KEY_BACKUP_STATE: OneTimePrivateKeyBackupState =
  {
    revealed: false,
    acknowledged: false,
    dismissed: false,
    copyStatus: "idle",
  };

export function shouldShowOneTimePrivateKeyBackup(
  source: WalletActivationSource,
): boolean {
  return source === "created";
}

export function reduceOneTimePrivateKeyBackupState(
  state: OneTimePrivateKeyBackupState,
  action: OneTimePrivateKeyBackupAction,
): OneTimePrivateKeyBackupState {
  if (state.dismissed) return state;

  switch (action.type) {
    case "show":
      return { ...state, revealed: true };
    case "hide":
      return { ...state, revealed: false };
    case "acknowledge":
      return { ...state, acknowledged: action.value };
    case "copy-succeeded":
      return { ...state, copyStatus: "copied" };
    case "copy-failed":
      return { ...state, copyStatus: "error" };
    case "clear-copy-status":
      return { ...state, copyStatus: "idle" };
    case "continue":
      return state.acknowledged
        ? {
            revealed: false,
            acknowledged: false,
            dismissed: true,
            copyStatus: "idle",
          }
        : state;
  }
}

export function schedulePrivateKeyAutoHide<T>(
  schedule: (callback: () => void, delayMs: number) => T,
  hide: () => void,
): T {
  return schedule(hide, PRIVATE_KEY_AUTO_HIDE_MS);
}

export async function copyPrivateKeyToClipboard(
  privateKey: Uint8Array,
  writeText: (value: string) => Promise<void>,
): Promise<"copied" | "error"> {
  if (privateKey.length !== 32) return "error";

  let privateKeyText = bytesToHex(privateKey);
  try {
    await writeText(privateKeyText);
    return "copied";
  } catch {
    return "error";
  } finally {
    privateKeyText = "";
  }
}
