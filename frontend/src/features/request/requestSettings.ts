import { SETTINGS_LIMITS, type AppSettings, type RequestSettings } from "@/lib/model";

/** Largest per-request timeout, in seconds (same limit as the app setting). */
export const MAX_TIMEOUT_S = SETTINGS_LIMITS.maxTimeoutMs / 1000;

/** Formats milliseconds as seconds for the timeout field ("30", "2.5"). */
export function formatSeconds(ms: number): string {
  return String(Math.round(ms) / 1000);
}

/** Parses seconds (up to 3 decimals) into milliseconds; null when it isn't in [0, MAX_TIMEOUT_S]. */
export function parseTimeout(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const ms = Math.round(Number(t) * 1000);
  return ms <= SETTINGS_LIMITS.maxTimeoutMs ? ms : null;
}

/** Parses a redirect limit in [1, cap]; null otherwise. */
export function parseMaxRedirects(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= SETTINGS_LIMITS.maxRedirects ? n : null;
}

export const TIMEOUT_ERROR = `Enter seconds from 0 to ${MAX_TIMEOUT_S}.`;
export const REDIRECTS_ERROR = `Enter a number from 1 to ${SETTINGS_LIMITS.maxRedirects}.`;

/** Returns settings with `key` set to `value`, or removed when `value` is undefined. */
export function withSetting<K extends keyof RequestSettings>(
  s: RequestSettings,
  key: K,
  value: RequestSettings[K] | undefined,
): RequestSettings {
  const next = { ...s };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** How many settings the request overrides. */
export function overrideCount(s: RequestSettings): number {
  return Object.values(s).filter((v) => v !== undefined).length;
}

/** The app setting a field falls back to, written for "Use app setting (…)". */
export function appValueLabel(key: keyof RequestSettings, app: AppSettings): string {
  switch (key) {
    case "timeoutMs":
      return app.timeoutMs === 0 ? "no limit" : `${formatSeconds(app.timeoutMs)} s`;
    case "followRedirects":
      return app.followRedirects ? "on" : "off";
    case "maxRedirects":
      return String(app.maxRedirects);
    case "verifyTls":
      return app.verifyTls ? "on" : "off";
  }
}
