import { useEffect } from "react";
import { api } from "@/lib/api";
import { useConsoleStore } from "@/stores/console";

/** Feeds live `script:console` events into the console store while a send runs. */
export function useConsoleSync(): void {
  useEffect(() => api.onScriptConsole((ev) => useConsoleStore.getState().append(ev.sendId, ev.entries)), []);
}
