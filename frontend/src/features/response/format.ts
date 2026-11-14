import type { Response, SendErrorKind } from "@/lib/model";
import { formatJSON, formatXML } from "@/features/request/beautify";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function statusTextClass(code: number): string {
  if (code >= 500) return "text-status-server";
  if (code >= 400) return "text-status-client";
  if (code >= 300) return "text-status-redirect";
  if (code >= 200) return "text-status-ok";
  return "text-muted-foreground";
}

/** Decodes the body for text display. base64 bodies are decoded as UTF-8 (lossy). */
export function bodyText(res: Pick<Response, "body" | "encoding">): string {
  if (res.encoding !== "base64") return res.body;
  try {
    const bin = atob(res.body);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return res.body;
  }
}

/** Above this size, Pretty shows the raw body instead of reformatting it. */
export const PRETTY_LIMIT = 2 * 1024 * 1024;

export type PrettyResult = { text: string; note: string | null };

export function prettyBody(res: Response): PrettyResult {
  const text = bodyText(res);
  if (res.kind !== "json" && res.kind !== "xml") return { text, note: null };
  if (text.length > PRETTY_LIMIT) {
    return { text, note: "This response is too large to format, so it's shown as received." };
  }
  const out = res.kind === "json" ? formatJSON(text) : formatXML(text);
  if (out === null)
    return { text, note: `This isn't valid ${res.kind.toUpperCase()}, so it's shown as received.` };
  return { text: out, note: null };
}

export function editorLanguage(kind: Response["kind"]): "json" | "xml" | "html" | "text" {
  if (kind === "json" || kind === "xml" || kind === "html") return kind;
  return "text";
}

export interface ErrorCopy {
  title: string;
  hint: string | null;
  /** Settings section that can fix this error, offered as an "Open settings" action. */
  settings?: "requests";
}

const ERROR_COPY: Record<SendErrorKind, ErrorCopy> = {
  invalid_url: {
    title: "The URL isn't valid",
    hint: "Check the URL, including the scheme, such as https://.",
  },
  invalid_request: { title: "The request couldn't be built", hint: "Check the method, headers and body." },
  file_not_found: { title: "A file to upload is missing", hint: "Choose the file again in the Body tab." },
  dns: { title: "Couldn't find the server", hint: "Check the host name and your network connection." },
  connection_refused: {
    title: "The server refused the connection",
    hint: "Check that the server is running and the port is right.",
  },
  tls: {
    title: "The secure connection failed",
    hint: "For a server with a self-signed certificate, turn off certificate verification in settings.",
    settings: "requests",
  },
  timeout: {
    title: "The request timed out",
    hint: "The server didn't answer in time. Try again, or raise the timeout in settings.",
    settings: "requests",
  },
  canceled: { title: "Request cancelled", hint: "Send it again when you're ready." },
  too_many_redirects: {
    title: "Too many redirects",
    hint: "The server kept redirecting. Check the URL, or turn off following redirects in settings.",
    settings: "requests",
  },
  network: { title: "The request failed", hint: "Check your network connection and try again." },
  variables: {
    title: "Variables couldn't be resolved",
    hint: "Nothing was sent. Fix the variables named above, then send again.",
  },
};

export function errorCopy(kind: string): ErrorCopy {
  return ERROR_COPY[kind as SendErrorKind] ?? ERROR_COPY.network;
}
