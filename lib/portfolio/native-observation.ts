import { ConsensusStatus, Pubkey, type Account } from "@thru/sdk";
import { createThruAccountReader } from "../thru/client";
import { THRU_NETWORK } from "../thru/network";
import { copyPortfolioScope, samePortfolioScope, unknownObservation,
  type NativeObservation, type PortfolioNetworkStatus, type PortfolioScope } from "./asset-model";

const U64_MAX = (1n << 64n) - 1n;
const READ_TIMEOUT_MS = 4_000;
export function unavailableNativeObservation(scope: PortfolioScope): NativeObservation {
  return { scope: copyPortfolioScope(scope), availability: "unavailable", rawBalance: null, observation: unknownObservation() };
}

/** Display observation only. Does not establish EOA readiness or spending authority. */
export function nativeObservationFromAccount(scope: PortfolioScope, account: Account, observedAt: number): NativeObservation {
  const meta = account.meta;
  if (account.address?.toThruFmt() !== scope.walletAddress || !meta ||
    typeof meta.balance !== "bigint" || meta.balance < 0n || meta.balance > U64_MAX ||
    !meta.flags || [meta.flags.isDeleted, meta.flags.isEphemeral, meta.flags.isCompressed].some((flag) => flag !== false) ||
    typeof meta.flags.isNew !== "boolean") return unavailableNativeObservation(scope);
  const status = account.consensusStatus;
  const authoritative = status === ConsensusStatus.FINALIZED || status === ConsensusStatus.CLUSTER_EXECUTED;
  if (!authoritative && status !== ConsensusStatus.INCLUDED) return unavailableNativeObservation(scope);
  const slot = account.versionContext?.slot, seq = account.versionContext?.seq ?? meta.seq;
  return { scope: copyPortfolioScope(scope), availability: "available", rawBalance: meta.balance,
    observation: { source: "rpc", observedAt: Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : null,
      finality: authoritative && !meta.flags.isNew ? "authoritative" : "provisional",
      consensus: status === ConsensusStatus.FINALIZED ? "FINALIZED" : status === ConsensusStatus.CLUSTER_EXECUTED ? "CLUSTER_EXECUTED" : "INCLUDED",
      version: { slot: typeof slot === "bigint" && slot >= 0n ? slot.toString() : null,
        seq: typeof seq === "bigint" && seq >= 0n ? seq.toString() : null } } };
}

export function visibleNativeObservation(scope: PortfolioScope | null, value: NativeObservation | null,
  status: PortfolioNetworkStatus): NativeObservation | null {
  return scope && value && samePortfolioScope(scope, value.scope) && (status === "Online" || status === "Degraded") ? value : null;
}

type ReaderFactory = (signal: AbortSignal, timeoutMs: number) => { get(address: string): Promise<Account> };
/** One point read per existing refresh trigger. No polling, retries, persistence or write API. */
export class NativeBalanceReader {
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private readonly reader: ReaderFactory = createThruAccountReader, private readonly now = Date.now) {}

  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  async read(scope: PortfolioScope, status: PortfolioNetworkStatus, isCurrent: () => boolean): Promise<NativeObservation | null> {
    if (!isCurrent()) return null;
    this.cancel();
    const generation = this.generation;
    if (status !== "Online" && status !== "Degraded") return unavailableNativeObservation(scope);
    if (scope.networkId !== THRU_NETWORK.id || scope.chainId !== THRU_NETWORK.expectedChainId) return unavailableNativeObservation(scope);
    if (!Pubkey.isThruFmt(scope.walletAddress) || Pubkey.from(scope.walletAddress).toThruFmt() !== scope.walletAddress) return unavailableNativeObservation(scope);
    const controller = new AbortController();
    this.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Native balance read cancelled."));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      });
      const account = await Promise.race([this.reader(controller.signal, READ_TIMEOUT_MS).get(scope.walletAddress), stopped]);
      if (controller.signal.aborted || generation !== this.generation || !isCurrent()) return null;
      return nativeObservationFromAccount(scope, account, this.now());
    } catch {
      // Not-found, incomplete responses, timeouts and transport errors never imply zero.
      return generation === this.generation && isCurrent() ? unavailableNativeObservation(scope) : null;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.controller === controller) this.controller = null;
    }
  }
}
