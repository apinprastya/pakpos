import { plural } from "@/lib/errors";
import type { Auth, Body, CodeResult, RawLanguage } from "@/lib/model";

/** True when pasted text is a curl command (after leading whitespace). */
export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

const RAW_LABELS: Record<RawLanguage, string> = {
  json: "JSON",
  xml: "XML",
  html: "HTML",
  javascript: "JavaScript",
  text: "Text",
};

/** One line describing a body, for the import preview. */
export function bodySummary(b: Body): string {
  switch (b.type) {
    case "raw":
      return `${RAW_LABELS[b.language] ?? "Text"} · ${plural(b.raw.length, "character")}`;
    case "urlencoded":
      return `URL-encoded form · ${plural(b.urlEncoded.length, "field")}`;
    case "form-data": {
      const files = b.formData.filter((f) => f.kind === "file").length;
      const fields = plural(b.formData.length, "field");
      return files ? `Multipart form · ${fields}, ${plural(files, "file")}` : `Multipart form · ${fields}`;
    }
    case "binary":
      return `File · ${b.binaryPath}`;
    default:
      return "No body";
  }
}

/** One line describing auth, for the import preview. */
export function authSummary(a: Auth): string {
  switch (a.type) {
    case "basic":
      return a.username ? `Basic auth as ${a.username}` : "Basic auth";
    case "bearer":
      return "Bearer token";
    case "apikey":
      return `API key ${a.apiKey}`;
    default:
      return "None";
  }
}

const refs = (names: string[]) => names.map((n) => `{{${n}}}`).join(", ");

/** Short notes about secrets and variables left in generated code, or [] when there are none. */
export function codeNotes(r: Pick<CodeResult, "masked" | "unresolved" | "secretsLocked">): string[] {
  const notes: string[] = [];
  if (r.masked.length) notes.push(`Secrets are shown as ${refs(r.masked)}.`);
  if (r.secretsLocked) notes.push("Secrets are locked, so secret variables are left as written.");
  if (r.unresolved.length) {
    const left = r.unresolved.length === 1 ? "it's" : "they're";
    notes.push(`No value for ${refs(r.unresolved)}, so ${left} left as written.`);
  }
  return notes;
}

/** What generated code leaves to the library, for the code dialog's notes. */
export function addedHeadersNote(languageId: string): string {
  return languageId === "curl"
    ? "Pakpos also sends User-Agent and Accept-Encoding; the command uses curl's defaults."
    : "Pakpos also sends User-Agent and Accept-Encoding; the generated code uses the library's defaults.";
}
