import { useState, useEffect, useCallback, useRef } from "react";
import { thru } from "@/lib/wallet/thru-wallet";

export type NetworkStatus = "Checking" | "Online" | "Degraded" | "Offline";

export interface AlphaNetHealth {
  status: NetworkStatus;
  lastChecked: string | null;
  checkNow: () => void;
}

export function useAlphaNetHealth(): AlphaNetHealth {
  const [status, setStatus] = useState<NetworkStatus>("Checking");
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  
  const consecutiveFailures = useRef(0);
  const sequenceId = useRef(0);
  const pollingTimer = useRef<NodeJS.Timeout | null>(null);
  const checkInProgress = useRef(false);

  const getFormattedTime = () => {
    const now = new Date();
    return now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const performCheck = useCallback(async () => {
    // If dev override is on
    if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
      const isMockOffline = localStorage.getItem("MOCK_RPC_OFFLINE") === "true";
      if (isMockOffline) {
        consecutiveFailures.current += 1;
        if (consecutiveFailures.current >= 2) {
          setStatus("Offline");
        } else {
          setStatus("Degraded");
        }
        setLastChecked(getFormattedTime());
        return;
      }
    }

    if (checkInProgress.current) return;
    checkInProgress.current = true;

    sequenceId.current += 1;
    const currentSeq = sequenceId.current;

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("RPC Timeout")), 4000);
      });

      // Race the actual RPC call against the timeout
      await Promise.race([
        thru.blocks.getBlockHeight(),
        timeoutPromise
      ]);

      if (currentSeq !== sequenceId.current) return;

      consecutiveFailures.current = 0;
      setStatus("Online");
      setLastChecked(getFormattedTime());
    } catch {
      if (currentSeq !== sequenceId.current) return;

      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= 2) {
        setStatus("Offline");
      } else {
        setStatus("Degraded");
      }
      setLastChecked(getFormattedTime());
    } finally {
      if (currentSeq === sequenceId.current) {
        checkInProgress.current = false;
      }
    }
  }, []);

  const scheduleNext = useCallback(() => {
    if (pollingTimer.current) clearTimeout(pollingTimer.current);
    pollingTimer.current = setTimeout(() => {
      void performCheck().then(() => {
        scheduleNext();
      });
    }, 10000);
  }, [performCheck]);

  useEffect(() => {
    // Initial check
    void performCheck().then(() => {
      scheduleNext();
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void performCheck().then(() => {
          scheduleNext();
        });
      } else {
        if (pollingTimer.current) {
          clearTimeout(pollingTimer.current);
          pollingTimer.current = null;
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollingTimer.current) {
        clearTimeout(pollingTimer.current);
        pollingTimer.current = null;
      }
      sequenceId.current += 1; // invalidate any in-flight
      checkInProgress.current = false;
    };
  }, [performCheck, scheduleNext]);

  return {
    status,
    lastChecked,
    checkNow: () => {
      if (pollingTimer.current) clearTimeout(pollingTimer.current);
      void performCheck().then(() => scheduleNext());
    }
  };
}
