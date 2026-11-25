/**
 * History entries as plain text for comparing: one block for the request
 * (as written, {{variables}} unresolved) and one for the response. Pure.
 */
import { prettyBody, formatBytes } from "@/features/response/format";
import { parseJson, stringifyJson } from "@/features/tools/json/json";
import type { HistoryEntry, KeyValue, Request } from "@/lib/model";

export interface TextOptions {
  /** Sort the keys of JSON bodies, so key order doesn't show as a change. */
  sortKeys: boolean;
}

function headerLines(headers: KeyValue[], onlyEnabled: boolean): string[] {
  return headers
    .filter((h) => (!onlyEnabled || h.enabled) && h.key.trim() !== "")
    .map((h) => `${h.key}: ${h.value}`);
}

/** JSON text formatted (and sorted), or null when it isn't JSON. */
function json(text: string, sortKeys: boolean): string | null {
  try {
    return stringifyJson(parseJson(text), "2", sortKeys);
  } catch {
    return null;
  }
}

function requestBody(req: Request, opts: TextOptions): string[] {
  const b = req.body;
  switch (b.type) {
    case "raw":
      if (!b.raw) return [];
      return (json(b.raw, opts.sortKeys) ?? b.raw).split("\n");
    case "urlencoded":
      return b.urlEncoded.filter((f) => f.enabled).map((f) => `${f.key}=${f.value}`);
    case "form-data":
      return b.formData
        .filter((f) => f.enabled)
        .map((f) => (f.kind === "file" ? `${f.key}: <file ${f.filePath}>` : `${f.key}: ${f.value}`));
    case "binary":
      return b.binaryPath ? [`<file ${b.binaryPath}>`] : [];
    default:
      return [];
  }
}

/** The request as sent: method and URL, query rows, headers, auth type, body. */
export function requestText(entry: HistoryEntry, opts: TextOptions): string[] {
  const req = entry.request;
  const out = [`${req.method} ${req.url}`];
  out.push(...headerLines(req.headers, true));
  if (req.auth.type !== "none" && req.auth.type !== "inherit") out.push(`Auth: ${req.auth.type}`);
  const body = requestBody(req, opts);
  if (body.length) out.push("", ...body);
  return out;
}

/** The response: status line, headers, then the body (formatted JSON or XML). */
export function responseText(entry: HistoryEntry, opts: TextOptions): string[] {
  const res = entry.response;
  if (!res) {
    return [`No response: ${entry.errorMessage || entry.errorKind || "the request failed"}`];
  }
  const status = res.statusText.startsWith(String(res.statusCode))
    ? res.statusText
    : `${res.statusCode} ${res.statusText}`.trim();
  const out = [status, ...headerLines(res.headers, false)];
  let body: string;
  if (res.kind === "binary" || res.encoding === "base64") body = `<binary body, ${formatBytes(res.size)}>`;
  else if (res.kind === "json" && opts.sortKeys) body = json(res.body, true) ?? prettyBody(res).text;
  else body = prettyBody(res).text;
  if (body) out.push("", ...body.split("\n"));
  if (res.truncated) out.push(`<cut: only the first part of a ${formatBytes(res.size)} body is kept>`);
  return out;
}
