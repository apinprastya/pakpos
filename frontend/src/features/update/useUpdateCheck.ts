import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settings";
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, useUpdateStore } from "@/stores/update";

/**
 * Checks for a new release shortly after start and then once a day, while the
 * "check for updates" setting is on (only once settings came from Go, so a
 * user who turned it off is never checked for).
 */
export function useUpdateCheck(): void {
  const enabled = useSettingsStore((s) => s.loaded && s.settings.checkForUpdates);
  useEffect(() => {
    if (!enabled) return;
    const run = () => void useUpdateStore.getState().autoCheck();
    const first = window.setTimeout(run, FIRST_CHECK_DELAY_MS);
    const daily = window.setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(daily);
    };
  }, [enabled]);
}
