export type NetworkStatus = "Checking" | "Online" | "Degraded" | "Offline";

export type NetworkProbeStatus = Exclude<NetworkStatus, "Checking">;

export interface NetworkHeightSnapshot {
  finalized: bigint;
  locallyExecuted: bigint;
  clusterExecuted: bigint;
}

export interface NetworkHealthProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NetworkHealthProbeToken {
  readonly sequence: number;
  readonly signal: AbortSignal;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 4_000;

function isNonNegativeBigInt(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

export function isUsableNetworkHeightSnapshot(
  value: unknown,
): value is NetworkHeightSnapshot {
  if (typeof value !== "object" || value === null) return false;

  const snapshot = value as Partial<NetworkHeightSnapshot>;
  if (
    !isNonNegativeBigInt(snapshot.finalized) ||
    !isNonNegativeBigInt(snapshot.locallyExecuted) ||
    !isNonNegativeBigInt(snapshot.clusterExecuted)
  ) {
    return false;
  }

  return (
    snapshot.finalized > 0n &&
    snapshot.locallyExecuted >= snapshot.finalized &&
    snapshot.clusterExecuted >= snapshot.finalized
  );
}

export async function probeNetworkHealth(
  readHeight: () => Promise<unknown>,
  options: NetworkHealthProbeOptions = {},
): Promise<NetworkProbeStatus> {
  const { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, signal } = options;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rejectUnavailable: (() => void) | null = null;

  const unavailable = new Promise<never>((_, reject) => {
    rejectUnavailable = () => {
      reject(new DOMException("Network health probe unavailable", "AbortError"));
    };

    if (signal?.aborted) {
      rejectUnavailable();
      return;
    }

    if (signal) {
      signal.addEventListener("abort", rejectUnavailable, { once: true });
    }

    timeout = setTimeout(rejectUnavailable, timeoutMs);
  });

  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(readHeight),
      unavailable,
    ]);
    return isUsableNetworkHeightSnapshot(snapshot) ? "Online" : "Degraded";
  } catch {
    return "Offline";
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && rejectUnavailable) {
      signal.removeEventListener("abort", rejectUnavailable);
    }
  }
}

export class NetworkHealthProbeSequence {
  private sequence = 0;
  private controller: AbortController | null = null;

  begin(): NetworkHealthProbeToken {
    this.controller?.abort();
    this.controller = new AbortController();
    this.sequence += 1;
    return {
      sequence: this.sequence,
      signal: this.controller.signal,
    };
  }

  isCurrent(token: NetworkHealthProbeToken): boolean {
    return (
      token.sequence === this.sequence &&
      !token.signal.aborted &&
      this.controller !== null &&
      this.controller.signal === token.signal
    );
  }

  cancel(): void {
    this.sequence += 1;
    this.controller?.abort();
    this.controller = null;
  }
}
