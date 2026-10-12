import type { Account } from "@thru/sdk";
import type { NetworkStatus } from "../network/network-health";
import { explorerTransactionUrl, THRU_NETWORK } from "../thru/network";
import { SAFE_TRANSACTION_UNCERTAIN_MESSAGE } from "../thru/transactions";
import type { NativeTransferResult } from "./native-transfer";
import type { PendingNativeTransfer } from "./pending-native-transfer";
import { assertNativeEoa, nativeTransferAddress, NativeTransferError, NATIVE_TRANSFER_HEADER,
  NATIVE_U64_MAX, parseNativeTransferAmount, validateNativeTransferBalances } from "./native-transfer-validation";

// Deliberately not an environment flag. Enable only after Phase 2D approval and smoke QA.
export const NATIVE_SEND_ENABLED = false;
export const NATIVE_ASSET_VALUE = "native-units";
export const NATIVE_ASSET_LABEL = "Native THRU — native units";
export type NativeSendPhase = "idle" | "preparing" | "awaiting-confirmation" | "submitting" | "confirming" | "success" | "failed" | "uncertain";
export interface NativeReview {
  wallet: string; recipient: string; amount: string; fee: string; total: string;
}
export interface NativeSendSnapshot {
  wallet: string; enabled: boolean; phase: NativeSendPhase;
  recipient: string; amount: string; balance: bigint | null;
  networkStatus: NetworkStatus; blocked: boolean; error: string | null;
  review: NativeReview | null; result: NativeTransferResult | null; revision: number;
}
export interface NativeControllerDependencies {
  /** Tests opt in only with mocked execution. Production always uses the false gate. */
  enabled: boolean;
  readAccount(address: string): Promise<Account>;
  chainId(): Promise<number>;
  pending(): PendingNativeTransfer | undefined;
  execute(recipient: string, amount: string, signal: AbortSignal): Promise<NativeTransferResult>;
  reconcile(signal: AbortSignal): Promise<NativeTransferResult | null>;
  onSuccess?(): void;
}
export function nativeSendBusy(state: NativeSendSnapshot): boolean {
  return ["preparing", "submitting", "confirming"].includes(state.phase);
}
export function nativeSendAvailable(state: NativeSendSnapshot): boolean {
  return state.enabled && !state.blocked && !nativeSendBusy(state) && state.phase !== "awaiting-confirmation" &&
    state.balance !== null && ["Online", "Degraded"].includes(state.networkStatus);
}
function safeError(error: unknown): string {
  return error instanceof NativeTransferError ? error.message : "The native transfer could not be verified safely. Try again when Betanet is available.";
}
async function readBounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => rejectRead?.(new NativeTransferError("ABORTED"));
  let rejectRead: ((error: Error) => void) | undefined;
  try {
    if (signal.aborted) throw new NativeTransferError("ABORTED");
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw new NativeTransferError("ABORTED");
      return work();
    }), new Promise<never>((_, reject) => {
      rejectRead = reject;
      timer = setTimeout(() => reject(new NativeTransferError("RPC_UNAVAILABLE")), 5_000);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

/** Public UI state only. Secrets and signed bytes never enter this controller. */
export class NativeTransferController {
  private state: NativeSendSnapshot;
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private generation = 0;
  private active = true;
  constructor(wallet: string, private readonly dependencies: NativeControllerDependencies) {
    this.state = { wallet: nativeTransferAddress(wallet), enabled: dependencies.enabled, phase: "idle",
      recipient: "", amount: "", balance: null, networkStatus: "Checking", blocked: false,
      error: null, review: null, result: null, revision: 0 };
  }
  getSnapshot = (): NativeSendSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private update(next: Partial<NativeSendSnapshot>) {
    this.state = { ...this.state, ...next }; this.listeners.forEach((listener) => listener());
  }
  setEnvironment(balance: bigint | null, status: NetworkStatus) {
    this.active = true;
    const changed = balance !== this.state.balance || status !== this.state.networkStatus;
    if (!changed) return;
    this.update({ balance, networkStatus: status });
    if (this.state.phase === "preparing" || this.state.phase === "awaiting-confirmation") this.cancelReview();
  }
  deactivate() {
    this.active = false;
    if (this.state.phase !== "submitting") this.generation++;
    this.request?.abort(); this.request = null;
    // Never turn a possibly submitted operation into a retryable cancellation.
    if (["submitting", "confirming"].includes(this.state.phase)) this.update({ phase: "uncertain", blocked: true, review: null });
    else this.cancelReview();
  }
  hydrate() {
    if (nativeSendBusy(this.state)) return;
    try {
      const record = this.dependencies.pending();
      if (record) this.update({ phase: "uncertain", blocked: true, review: null,
        recipient: record.recipientAddress, amount: record.amountRaw, error: null,
        result: { outcome: "uncertain", signature: record.signature, explorerUrl: explorerTransactionUrl(record.signature), message: SAFE_TRANSACTION_UNCERTAIN_MESSAGE } });
    } catch (error) { this.update({ phase: "failed", blocked: true, error: safeError(error), review: null }); }
  }
  setDraft(field: "recipient" | "amount", value: string) {
    if (this.state.blocked || ["submitting", "confirming"].includes(this.state.phase)) return;
    this.cancelReview();
    this.update({ [field]: value, phase: "idle", error: null, result: null });
  }
  cancelReview = () => {
    if (["submitting", "confirming"].includes(this.state.phase)) return;
    this.generation++; this.request?.abort(); this.request = null;
    this.update({ review: null, phase: this.state.blocked ? this.state.phase : "idle" });
  };
  async prepare(useMax = false) {
    if (!this.active || !nativeSendAvailable(this.state)) return;
    this.hydrate();
    if (!nativeSendAvailable(this.state)) return;
    const generation = ++this.generation;
    const request = new AbortController(); this.request = request;
    const { wallet, recipient: input, amount: amountInput } = this.state;
    this.update({ phase: "preparing", error: null, result: null });
    try {
      const recipient = nativeTransferAddress(input);
      if (recipient === wallet) throw new NativeTransferError("SELF_TRANSFER");
      if (!useMax) parseNativeTransferAmount(amountInput);
      const [source, destination, chain] = await readBounded(() => Promise.all([
        this.dependencies.readAccount(wallet), this.dependencies.readAccount(recipient), this.dependencies.chainId(),
      ]), request.signal);
      assertNativeEoa(source, wallet); assertNativeEoa(destination, recipient);
      if (chain !== THRU_NETWORK.expectedChainId) throw new NativeTransferError("WRONG_NETWORK");
      if (!source.meta || !destination.meta) throw new NativeTransferError("INVALID_ACCOUNT");
      const spendable = source.meta.balance - NATIVE_TRANSFER_HEADER.fee;
      const capacity = NATIVE_U64_MAX - destination.meta.balance;
      const amount = useMax ? (spendable < capacity ? spendable : capacity) : parseNativeTransferAmount(amountInput);
      validateNativeTransferBalances(source.meta.balance, destination.meta.balance, amount);
      if (generation !== this.generation || request.signal.aborted || !this.active) return;
      this.update({ balance: source.meta.balance });
      if (useMax) this.update({ amount: amount.toString(), phase: "idle" });
      else this.update({ phase: "awaiting-confirmation", review: { wallet, recipient,
        amount: amount.toString(), fee: NATIVE_TRANSFER_HEADER.fee.toString(), total: (amount + NATIVE_TRANSFER_HEADER.fee).toString() } });
    } catch (error) {
      if (generation === this.generation && !request.signal.aborted) this.update({ phase: "failed", error: safeError(error) });
    } finally { if (this.request === request) this.request = null; }
  }
  confirm = async () => {
    const review = this.state.review;
    if (!this.active || !this.state.enabled || this.state.blocked || this.state.phase !== "awaiting-confirmation" || !review ||
        this.state.balance === null || !["Online", "Degraded"].includes(this.state.networkStatus)) return;
    this.hydrate();
    if (this.state.blocked) return;
    const generation = ++this.generation;
    const request = new AbortController(); this.request = request;
    // Synchronous latch shared by all subscribers, BEFORE invoking the signing boundary.
    this.update({ phase: "submitting", blocked: true, review: null, error: null });
    try {
      const result = await this.dependencies.execute(review.recipient, review.amount, request.signal);
      if (generation === this.generation) this.accept(result);
    } catch (error) {
      if (generation !== this.generation) return;
      // A thrown submission may still have a durable public intent. Never erase it.
      try {
        if (this.dependencies.pending()) {
          this.update({ phase: "uncertain" }); this.hydrate();
        } else this.update({ phase: "failed", blocked: false, error: safeError(error) });
      } catch { this.update({ phase: "uncertain", blocked: true, error: "Secure pending-transfer storage is unavailable. Verify before trying again." }); }
    } finally { if (this.request === request) this.request = null; }
  };
  private accept(result: NativeTransferResult) {
    this.update({ phase: result.outcome === "failure" ? "failed" : result.outcome,
      result, error: result.outcome === "failure" ? "The native transfer was rejected during execution." : null,
      blocked: result.outcome === "uncertain" || !!result.persistenceWarning,
      revision: this.state.revision + (result.outcome === "success" ? 1 : 0) });
    if (result.outcome === "success" && this.active) {
      try { this.dependencies.onSuccess?.(); }
      catch { /* Refresh failures never undo transaction-specific verified success. */ }
    }
  }
  reconcile = async () => {
    if (!this.active || nativeSendBusy(this.state) || !this.state.blocked || !["Online", "Degraded"].includes(this.state.networkStatus)) return;
    const generation = ++this.generation;
    const request = new AbortController(); this.request = request;
    this.update({ phase: "confirming", error: null, review: null });
    try {
      const result = await this.dependencies.reconcile(request.signal);
      if (generation !== this.generation || !this.active) return;
      if (result) this.accept(result);
      else this.update({ phase: "uncertain", error: "No pending transfer could be verified. Check the Explorer before trying again." });
    } catch {
      if (generation === this.generation && this.active) this.update({ phase: "uncertain", error: SAFE_TRANSACTION_UNCERTAIN_MESSAGE });
    } finally { if (this.request === request) this.request = null; }
  };
}
