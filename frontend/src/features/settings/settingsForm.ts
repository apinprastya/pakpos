import { SETTINGS_LIMITS, type AppSettings } from "@/lib/model";

/** Editable form state: numbers stay strings while the user types. */
export interface SettingsDraft {
  theme: AppSettings["theme"];
  layout: AppSettings["layout"];
  timeoutSeconds: string;
  followRedirects: boolean;
  maxRedirects: string;
  verifyTls: boolean;
  historyRetention: string;
}

export type DraftErrors = Partial<Record<"timeoutSeconds" | "maxRedirects" | "historyRetention", string>>;

export function toDraft(s: AppSettings): SettingsDraft {
  return {
    theme: s.theme,
    layout: s.layout,
    timeoutSeconds: formatSeconds(s.timeoutMs),
    followRedirects: s.followRedirects,
    maxRedirects: String(s.maxRedirects),
    verifyTls: s.verifyTls,
    historyRetention: String(s.historyRetention),
  };
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

/** Parses a whole number in [min, max]; null when it isn't one. */
export function parseWhole(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

const MAX_TIMEOUT_S = SETTINGS_LIMITS.maxTimeoutMs / 1000;

/** Validates the draft; returns settings to save, or the field errors. */
export function fromDraft(
  d: SettingsDraft,
  base: AppSettings,
): { settings: AppSettings; errors: null } | { settings: null; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const timeout = parseWhole(d.timeoutSeconds, 0, MAX_TIMEOUT_S);
  if (timeout === null) errors.timeoutSeconds = `Enter whole seconds from 0 to ${MAX_TIMEOUT_S}.`;

  let maxRedirects = parseWhole(d.maxRedirects, 1, SETTINGS_LIMITS.maxRedirects);
  if (maxRedirects === null) {
    // Ignored while redirects are off, so keep the saved value instead of blocking.
    if (d.followRedirects) errors.maxRedirects = `Enter a number from 1 to ${SETTINGS_LIMITS.maxRedirects}.`;
    else maxRedirects = base.maxRedirects;
  }

  const retention = parseWhole(d.historyRetention, 0, SETTINGS_LIMITS.maxHistoryRetention);
  if (retention === null)
    errors.historyRetention = `Enter a number from 0 to ${SETTINGS_LIMITS.maxHistoryRetention.toLocaleString("en-US")}.`;

  if (Object.keys(errors).length > 0) return { settings: null, errors };
  return {
    settings: {
      theme: d.theme,
      layout: d.layout,
      timeoutMs: timeout! * 1000,
      followRedirects: d.followRedirects,
      maxRedirects: maxRedirects!,
      verifyTls: d.verifyTls,
      historyRetention: retention!,
    },
    errors: null,
  };
}

/** True when saving would delete history entries (retention lowered, and not "keep all"). */
export function lowersRetention(draft: SettingsDraft, saved: AppSettings): boolean {
  const next = parseWhole(draft.historyRetention, 0, SETTINGS_LIMITS.maxHistoryRetention);
  if (next === null || next === 0) return false;
  return saved.historyRetention === 0 || next < saved.historyRetention;
}
