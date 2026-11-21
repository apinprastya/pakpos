/** Pure helpers of the webhook views (kept out of component files for fast refresh). */
import {
  ANY_METHOD,
  isRunning,
  requestTarget,
  type WebhookRequestSummary,
  type WebhookRule,
  type WebhookStatus,
} from "@/lib/webhookModel";

/** What the header says about a webhook's server and tunnel. */
export function statusText(st: WebhookStatus | undefined): string {
  if (!isRunning(st)) return "Stopped";
  switch (st.state) {
    case "tunnel-starting":
      return "Starting the public tunnel…";
    case "tunnel-failed":
      return st.message || "The tunnel stopped.";
    default:
      return st.tunnel ? "Live on a public URL" : "Running on this computer only";
  }
}

/** Clock time of a logged request, with seconds. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** True when the entry matches a filter typed by the user (method, path, status or rule). */
export function matchesFilter(e: WebhookRequestSummary, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return [e.method, requestTarget(e), String(e.status), e.ruleName || "default response"].some((v) =>
    v.toLowerCase().includes(f),
  );
}

/** Moves the rule at `from` to `to` (both in range), returning a new list. */
export function moveRule(rules: WebhookRule[], from: number, to: number): WebhookRule[] {
  if (from === to || from < 0 || to < 0 || from >= rules.length || to >= rules.length) return rules;
  const next = [...rules];
  const [r] = next.splice(from, 1);
  next.splice(to, 0, r);
  return next;
}

/** A rule's one-line description for the list: "POST /payments/* · 400". */
export function ruleSummary(r: WebhookRule): string {
  const method = r.match.method === ANY_METHOD ? "Any" : r.match.method;
  const conds = r.match.conditions.length ? ` +${r.match.conditions.length}` : "";
  return `${method} ${r.match.path || "/"}${conds} · ${r.response.status}`;
}
