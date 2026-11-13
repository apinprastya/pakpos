/**
 * URL ↔ params-table sync. Mirrors internal/core/urlx (Go) so the URL bar
 * updates locally while typing. Tolerant of partial or invalid URLs.
 */
import type { KeyValue } from "./model";

export interface SplitURL {
  base: string;
  query: string;
  fragment: string;
  hasQuery: boolean;
}

export function splitURL(raw: string): SplitURL {
  let rest = raw;
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const q = rest.indexOf("?");
  if (q >= 0) return { base: rest.slice(0, q), query: rest.slice(q + 1), fragment, hasQuery: true };
  return { base: rest, query: "", fragment, hasQuery: false };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

export function parseQuery(query: string): KeyValue[] {
  const rows: KeyValue[] = [];
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const value = eq >= 0 ? part.slice(eq + 1) : "";
    rows.push({ key: decode(key), value: decode(value), enabled: true });
  }
  return rows;
}

export function queryFromURL(raw: string): KeyValue[] {
  return parseQuery(splitURL(raw).query);
}

const DISPLAY_SAFE = new Set("-._~!$'()*,;:@/?{}[]");
const encoder = new TextEncoder();

function encodeDisplay(s: string): string {
  let out = "";
  for (const byte of encoder.encode(s)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9]/.test(c) || DISPLAY_SAFE.has(c)) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function buildQuery(rows: KeyValue[]): string {
  return rows
    .filter((r) => r.enabled && (r.key !== "" || r.value !== ""))
    .map((r) => (r.value === "" ? encodeDisplay(r.key) : `${encodeDisplay(r.key)}=${encodeDisplay(r.value)}`))
    .join("&");
}

/** Replaces the query of raw with the enabled rows, keeping base and fragment. */
export function withQuery(raw: string, rows: KeyValue[]): string {
  const { base, fragment } = splitURL(raw);
  let out = base;
  const q = buildQuery(rows);
  if (q) out += "?" + q;
  if (fragment) out += "#" + fragment;
  return out;
}

/** Rows parsed from the URL, followed by previous disabled rows (never in the URL). */
export function mergeQuery(raw: string, previous: KeyValue[]): KeyValue[] {
  return [...queryFromURL(raw), ...previous.filter((r) => !r.enabled)];
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function splitPath(base: string): { authority: string; path: string } {
  const m = SCHEME_RE.exec(base);
  const start = m ? m[0].length : 0;
  const slash = base.indexOf("/", start);
  if (slash >= 0) return { authority: base.slice(0, slash), path: base.slice(slash) };
  return { authority: base, path: "" };
}

export function pathParamNames(raw: string): string[] {
  const { path } = splitPath(splitURL(raw).base);
  const names: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg.startsWith(":")) continue;
    const name = seg.slice(1);
    if (PARAM_NAME_RE.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** One row per path param in raw, keeping values from previous rows with the same key. */
export function syncPathParams(raw: string, previous: KeyValue[]): KeyValue[] {
  const old = new Map(previous.map((p) => [p.key, p.value]));
  return pathParamNames(raw).map((key) => ({ key, value: old.get(key) ?? "", enabled: true }));
}

/** Host (with port) of raw, or "" when it can't be determined. */
export function hostOf(raw: string): string {
  const base = splitURL(raw.trim()).base;
  if (base.startsWith("{{")) return "";
  const { authority } = splitPath(base);
  const host = authority.replace(SCHEME_RE, "");
  const at = host.lastIndexOf("@");
  return at >= 0 ? host.slice(at + 1) : host;
}
