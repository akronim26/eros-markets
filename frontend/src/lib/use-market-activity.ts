"use client";
import { useEffect } from "react";

export const HEARTBEAT_MS = 30_000;

/** Tells the testnet supervisor someone is viewing this market. Visible tabs only. */
export function useMarketActivity(engine: string, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const beat = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < HEARTBEAT_MS - 1000) return;
      last = Date.now();
      // A failed heartbeat only means the market may sleep; never surface it as an error.
      void fetch("/api/market-activity", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine }), keepalive: true }).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", beat); };
  }, [engine, enabled]);
}
