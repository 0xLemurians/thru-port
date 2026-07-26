import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlphaNetHealthProbeSequence,
  probeAlphaNetHealth,
  type NetworkStatus,
} from "@/lib/network/alphanet-health";
import { thru } from "@/lib/wallet/thru-wallet";

export type { NetworkStatus } from "@/lib/network/alphanet-health";

export interface AlphaNetHealth {
  status: NetworkStatus;
  lastChecked: string | null;
  checkNow: () => void;
}

function getFormattedTime(): string {
  return new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function useAlphaNetHealth(): AlphaNetHealth {
  const [status, setStatus] = useState<NetworkStatus>("Checking");
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const pollingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeSequence = useRef(new AlphaNetHealthProbeSequence());

  const performCheck = useCallback(async () => {
    const token = probeSequence.current.begin();

    if (
      process.env.NODE_ENV === "development" &&
      typeof window !== "undefined" &&
      localStorage.getItem("MOCK_RPC_OFFLINE") === "true"
    ) {
      if (probeSequence.current.isCurrent(token)) {
        setStatus("Offline");
        setLastChecked(getFormattedTime());
      }
      return;
    }

    const nextStatus = await probeAlphaNetHealth(
      () => thru.blocks.getBlockHeight(),
      { signal: token.signal },
    );

    if (!probeSequence.current.isCurrent(token)) return;
    setStatus(nextStatus);
    setLastChecked(getFormattedTime());
  }, []);

  const scheduleNext = useCallback(() => {
    if (pollingTimer.current) clearTimeout(pollingTimer.current);
    pollingTimer.current = setTimeout(() => {
      void performCheck().then(scheduleNext);
    }, 10_000);
  }, [performCheck]);

  useEffect(() => {
    const activeProbeSequence = probeSequence.current;
    void performCheck().then(scheduleNext);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void performCheck().then(scheduleNext);
        return;
      }

      if (pollingTimer.current) {
        clearTimeout(pollingTimer.current);
        pollingTimer.current = null;
      }
      activeProbeSequence.cancel();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollingTimer.current) {
        clearTimeout(pollingTimer.current);
        pollingTimer.current = null;
      }
      activeProbeSequence.cancel();
    };
  }, [performCheck, scheduleNext]);

  return {
    status,
    lastChecked,
    checkNow: () => {
      if (pollingTimer.current) {
        clearTimeout(pollingTimer.current);
        pollingTimer.current = null;
      }
      void performCheck().then(scheduleNext);
    },
  };
}
