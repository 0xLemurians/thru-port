export type NetworkStatus = "Checking" | "Online" | "Degraded" | "Offline";

export type AlphaNetProbeStatus = Exclude<NetworkStatus, "Checking">;

export interface AlphaNetHeightSnapshot {
  finalized: bigint;
  locallyExecuted: bigint;
  clusterExecuted: bigint;
}

export interface AlphaNetHealthProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AlphaNetHealthProbeToken {
  readonly sequence: number;
  readonly signal: AbortSignal;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 4_000;

function isNonNegativeBigInt(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

export function isUsableAlphaNetHeightSnapshot(
  value: unknown,
): value is AlphaNetHeightSnapshot {
  if (typeof value !== "object" || value === null) return false;

  const snapshot = value as Partial<AlphaNetHeightSnapshot>;
  if (
    !isNonNegativeBigInt(snapshot.finalized) ||
    !isNonNegativeBigInt(snapshot.locallyExecuted) ||
    !isNonNegativeBigInt(snapshot.clusterExecuted)
  ) {
    return false;
  }

  // @thru/sdk 0.2.39 maps omitted protobuf height fields to 0n. A positive
  // finalized height and execution heights at least as recent are therefore
  // required before the response is usable network state rather than merely
  // a successful transport response.
  return (
    snapshot.finalized > 0n &&
    snapshot.locallyExecuted >= snapshot.finalized &&
    snapshot.clusterExecuted >= snapshot.finalized
  );
}

export async function probeAlphaNetHealth(
  readHeight: () => Promise<unknown>,
  options: AlphaNetHealthProbeOptions = {},
): Promise<AlphaNetProbeStatus> {
  const { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, signal } = options;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rejectUnavailable: (() => void) | null = null;

  const unavailable = new Promise<never>((_, reject) => {
    rejectUnavailable = () => {
      reject(new DOMException("AlphaNet health probe unavailable", "AbortError"));
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
    return isUsableAlphaNetHeightSnapshot(snapshot) ? "Online" : "Degraded";
  } catch {
    return "Offline";
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && rejectUnavailable) {
      signal.removeEventListener("abort", rejectUnavailable);
    }
  }
}

export class AlphaNetHealthProbeSequence {
  private sequence = 0;
  private controller: AbortController | null = null;

  begin(): AlphaNetHealthProbeToken {
    this.controller?.abort();
    this.controller = new AbortController();
    this.sequence += 1;
    return {
      sequence: this.sequence,
      signal: this.controller.signal,
    };
  }

  isCurrent(token: AlphaNetHealthProbeToken): boolean {
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
