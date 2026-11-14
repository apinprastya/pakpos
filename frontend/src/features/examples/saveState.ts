import { MAX_EXAMPLE_BODY, statusName } from "@/lib/model";
import type { Tab } from "@/stores/tabs";

export const TOO_LARGE = "Response bodies over 1 MB can't be saved as examples.";

export type SaveExampleState = { ok: true; defaultName: string } | { ok: false; reason: string };

/** Whether the tab's last response can be saved as an example, and why not. */
export function saveExampleState(tab: Tab): SaveExampleState {
  const response = tab.result?.response;
  if (!response || tab.result?.error) return { ok: false, reason: "There's no response to save." };
  if (!tab.saved || !tab.request.id) return { ok: false, reason: "Save the request first." };
  if (response.truncated || response.size > MAX_EXAMPLE_BODY) return { ok: false, reason: TOO_LARGE };
  if (!tab.result?.historyId) {
    return { ok: false, reason: "This response wasn't recorded. Send the request again to save it." };
  }
  return { ok: true, defaultName: statusName(response.statusCode, response.statusText) };
}

/** Short date and time for an example's "saved" label. */
export function savedLabel(savedAt: string, now: Date = new Date()): string {
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
