import type { StoredCookie } from "@/lib/model";

/** A cookie being added or edited; the expiry stays text while typed. */
export interface CookieDraft {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Also send to subdomains (the opposite of host-only). */
  subdomains: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: StoredCookie["sameSite"];
  /** "session" or "date"; with "date", `expires` is a datetime-local value. */
  lifetime: "session" | "date";
  expires: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Formats Unix ms as a datetime-local value in local time ("2026-11-18T09:30"). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a datetime-local value (local time) into Unix ms; null when it isn't one. */
export function fromLocalInput(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, Number.isNaN(s) ? 0 : s);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function emptyCookieDraft(domain = "", now = Date.now()): CookieDraft {
  return {
    name: "",
    value: "",
    domain,
    path: "/",
    subdomains: false,
    secure: false,
    httpOnly: false,
    sameSite: "",
    lifetime: "date",
    expires: toLocalInput(now + 24 * 60 * 60 * 1000),
  };
}

export function toCookieDraft(c: StoredCookie, now = Date.now()): CookieDraft {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    subdomains: !c.hostOnly,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    lifetime: c.expiresAt === 0 ? "session" : "date",
    expires: toLocalInput(c.expiresAt === 0 ? now + 24 * 60 * 60 * 1000 : c.expiresAt),
  };
}

/** The cookie to send to Go, or the problem with the draft (Go checks the rest). */
export function fromCookieDraft(
  d: CookieDraft,
): { cookie: StoredCookie; error: null } | { cookie: null; error: string } {
  if (d.name.trim() === "") return { cookie: null, error: "Enter a name." };
  if (d.domain.trim() === "")
    return { cookie: null, error: "Enter the domain the cookie is for, e.g. api.example.com." };
  let expiresAt = 0;
  if (d.lifetime === "date") {
    const ms = fromLocalInput(d.expires);
    if (ms === null) return { cookie: null, error: "Enter when the cookie expires." };
    expiresAt = ms;
  }
  return {
    cookie: {
      name: d.name.trim(),
      value: d.value,
      domain: d.domain.trim().replace(/^\./, "").toLowerCase(),
      path: d.path.trim() || "/",
      hostOnly: !d.subdomains,
      secure: d.secure,
      httpOnly: d.httpOnly,
      sameSite: d.sameSite,
      expiresAt,
      createdAt: 0,
    },
    error: null,
  };
}

/** "Session", or the expiry in the user's locale. */
export function expiryLabel(c: StoredCookie): string {
  return c.expiresAt === 0 ? "Session" : new Date(c.expiresAt).toLocaleString();
}

/** "Secure, HttpOnly, SameSite=Lax", or "" when none. */
export function flagsLabel(c: StoredCookie): string {
  const same = c.sameSite ? `SameSite=${c.sameSite[0].toUpperCase()}${c.sameSite.slice(1)}` : "";
  return [c.secure && "Secure", c.httpOnly && "HttpOnly", same].filter(Boolean).join(", ");
}
