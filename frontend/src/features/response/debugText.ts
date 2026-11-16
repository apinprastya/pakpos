import type { Hop } from "@/lib/model";
import { formatBytes } from "./format";

/**
 * The hops of a send as an HTTP transcript: each exchange starts with a
 * `###` line (as in .http files) saying where it went, then the request as
 * written (request line, headers, body) and the response's status line and
 * headers. Response bodies are left to the Body tab.
 */
export function debugText(hops: Hop[]): string {
  return hops.map((h, i) => hopText(h, i, hops.length)).join("\n\n");
}

function hopText(h: Hop, i: number, count: number): string {
  const lines = [`### ${hopTitle(i, count)}${connection(h)}`];
  lines.push(`${h.method} ${h.url}${h.proto ? ` ${h.proto}` : ""}`);
  for (const kv of h.requestHeaders) lines.push(`${kv.key}: ${kv.value}`);
  const body = requestBody(h);
  if (body) lines.push("", body);
  lines.push("");
  if (h.error) {
    lines.push(`[Failed: ${h.error}]`);
  } else {
    lines.push(`${h.proto} ${h.statusCode}${h.statusText ? ` ${h.statusText}` : ""}`);
    for (const kv of h.responseHeaders) lines.push(`${kv.key}: ${kv.value}`);
  }
  return lines.join("\n");
}

function hopTitle(i: number, count: number): string {
  if (count === 1) return "Request";
  return i === 0 ? `Request (1 of ${count})` : `Redirect ${i} (${i + 1} of ${count})`;
}

function connection(h: Hop): string {
  const parts = [
    h.remoteAddr,
    h.tls,
    h.remoteAddr ? (h.reusedConn ? "reused connection" : "new connection") : "",
  ];
  const s = parts.filter(Boolean).join(", ");
  return s ? ` · ${s}` : "";
}

function requestBody(h: Hop): string {
  if (h.requestBodyNote) return `[${h.requestBodyNote}]`;
  if (h.requestBodySize === 0) return "";
  if (h.requestBodyEncoding === "base64") return `[Binary body, ${formatBytes(h.requestBodySize)}]`;
  if (h.requestBodyTruncated) {
    const shown = new TextEncoder().encode(h.requestBody).length;
    return `${h.requestBody}\n[Showing the first ${formatBytes(shown)} of ${formatBytes(h.requestBodySize)}]`;
  }
  return h.requestBody;
}

/** A one-line summary for the toolbar, e.g. "2 requests, 1 redirect". */
export function debugSummary(hops: Hop[]): string {
  if (hops.length === 1) return "1 request";
  const redirects = hops.length - 1;
  return `${hops.length} requests, ${redirects} ${redirects === 1 ? "redirect" : "redirects"}`;
}
