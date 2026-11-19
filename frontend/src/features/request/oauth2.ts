import type { OAuth2, OAuth2Grant, OAuth2Status } from "@/lib/model";

export const GRANT_LABELS: Record<OAuth2Grant, string> = {
  authorization_code: "Authorization code (with PKCE)",
  client_credentials: "Client credentials",
  password: "Password",
  implicit: "Implicit",
};

export const GRANTS = Object.keys(GRANT_LABELS) as OAuth2Grant[];

export function grantOf(o: OAuth2): OAuth2Grant {
  return o.grant || "authorization_code";
}

/** Which fields a grant uses. */
export function fieldsFor(grant: OAuth2Grant) {
  const browser = grant === "authorization_code" || grant === "implicit";
  return {
    authUrl: browser,
    callback: browser,
    tokenUrl: grant !== "implicit",
    clientSecret: grant !== "implicit",
    clientAuth: grant !== "implicit",
    credentials: grant === "password",
    pkce: grant === "authorization_code",
    refresh: grant !== "implicit",
  };
}

/** The default port suggested when switching to a fixed callback. */
export const DEFAULT_CALLBACK = "http://127.0.0.1:8765/callback";

/** Mirrors Go's oauth2.ParseRedirect: "" (random) or a loopback http URL with a port. */
export function callbackProblem(url: string): string | null {
  if (url.trim() === "") return null;
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})(\/[^?#]*)?$/.exec(url.trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    return "Use http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>.";
  }
  return null;
}

/** "in 5 min", "3 h ago", "just now". */
export function relativeTime(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff >= 0 ? "in a few seconds" : "just now";
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "min"],
  ];
  const [size, unit] = units.find(([s]) => abs >= s) ?? units[2];
  const n = Math.round(abs / size);
  return diff >= 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

export type TokenTone = "none" | "valid" | "expired" | "locked";

/** A one-line description of a token's state. */
export function tokenSummary(st: OAuth2Status | undefined, now: number): { text: string; tone: TokenTone } {
  if (!st) return { text: "Checking the token…", tone: "none" };
  if (st.locked)
    return { text: "The secret store is locked, so the token can't be checked.", tone: "locked" };
  if (!st.hasToken) return { text: "No access token yet.", tone: "none" };
  if (!st.expiresAt) return { text: "Access token without an expiry.", tone: "valid" };
  if (st.expiresAt <= now) {
    return { text: `Expired ${relativeTime(st.expiresAt, now)}.`, tone: "expired" };
  }
  const at = new Date(st.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return { text: `Valid until ${at} (${relativeTime(st.expiresAt, now)}).`, tone: "valid" };
}
