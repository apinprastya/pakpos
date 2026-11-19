import type { Request } from "@/lib/model";
import { hostOf } from "@/lib/urlx";

export interface AutoHeader {
  name: string;
  value: string;
  /** True when an enabled user header with the same name replaces it. */
  overridden: boolean;
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  html: "text/html; charset=utf-8",
  javascript: "application/javascript",
  text: "text/plain; charset=utf-8",
};

/** Headers Pakpos adds when sending (mirrors httpexec.Build and auth.Apply). */
export function autoHeaders(req: Request, userAgent: string): AutoHeader[] {
  const user = new Set(
    req.headers.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase()),
  );
  const list: Omit<AutoHeader, "overridden">[] = [];
  const host = hostOf(req.url);
  if (host) list.push({ name: "Host", value: host });
  list.push({ name: "User-Agent", value: userAgent });
  // Keep in step with httpexec.AcceptEncoding.
  list.push({ name: "Accept-Encoding", value: "gzip, deflate, br" });

  const b = req.body;
  if (b.type === "raw") list.push({ name: "Content-Type", value: RAW_CONTENT_TYPES[b.language] });
  if (b.type === "urlencoded")
    list.push({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
  if (b.type === "form-data") list.push({ name: "Content-Type", value: "multipart/form-data; boundary=…" });
  if (b.type === "binary") list.push({ name: "Content-Type", value: "application/octet-stream" });

  const a = req.auth;
  if (a.type === "basic") list.push({ name: "Authorization", value: "Basic …" });
  if (a.type === "bearer" && a.token)
    list.push({ name: "Authorization", value: `${a.prefix || "Bearer"} …` });
  if (a.type === "apikey" && a.apiIn === "header" && a.apiKey) list.push({ name: a.apiKey, value: "…" });
  if (a.type === "jwt" && a.jwt?.placement !== "query")
    list.push({ name: "Authorization", value: `${a.jwt?.headerPrefix || "Bearer"} …` });
  if (a.type === "hawk") list.push({ name: "Authorization", value: "Hawk …" });
  if (a.type === "awsv4") {
    list.push({ name: "Authorization", value: "AWS4-HMAC-SHA256 …" });
    list.push({ name: "X-Amz-Date", value: "…" });
    if (a.awsv4?.sessionToken) list.push({ name: "X-Amz-Security-Token", value: "…" });
  }
  if (a.type === "digest" || a.type === "ntlm")
    list.push({ name: "Authorization", value: a.type === "digest" ? "Digest … (after a 401)" : "NTLM …" });

  return list.map((h) => ({ ...h, overridden: user.has(h.name.toLowerCase()) }));
}
