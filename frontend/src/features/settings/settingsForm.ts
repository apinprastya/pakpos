import { SETTINGS_LIMITS, type AppSettings, type ClientCert, type ProxyMode } from "@/lib/model";

/** A client certificate row being edited. */
export interface CertDraft {
  id: string;
  host: string;
  kind: "pem" | "pfx";
  certFile: string;
  keyFile: string;
  pfxFile: string;
  /** Typed passphrase for a PKCS#12 file; "" leaves the stored one alone. */
  passphrase: string;
}

/** Editable form state: numbers stay strings while the user types. */
export interface SettingsDraft {
  theme: AppSettings["theme"];
  layout: AppSettings["layout"];
  timeoutSeconds: string;
  /** Pre-request and test script timeout, whole seconds. */
  scriptTimeoutSeconds: string;
  followRedirects: boolean;
  maxRedirects: string;
  verifyTls: boolean;
  historyRetention: string;
  checkForUpdates: boolean;
  proxyMode: ProxyMode;
  proxyUrl: string;
  proxyUsername: string;
  proxyBypass: string;
  /** Typed proxy password; "" leaves the stored one alone. */
  proxyPassword: string;
  /** Delete the stored proxy password on save. */
  clearProxyPassword: boolean;
  caFile: string;
  certs: CertDraft[];
}

export type DraftErrors = Partial<
  Record<
    | "timeoutSeconds"
    | "scriptTimeoutSeconds"
    | "maxRedirects"
    | "historyRetention"
    | "proxyUrl"
    | "proxyBypass",
    string
  >
> & {
  /** Errors of client certificate rows, by id. */
  certs?: Record<string, string>;
};

/** Passwords to store once the settings are saved ("" deletes). */
export interface PendingSecrets {
  proxyPassword?: string;
  certPassphrases: { id: string; passphrase: string }[];
}

let nextId = 0;
/** A new client certificate id (Go keeps ids it is given). */
export function newCertId(): string {
  nextId += 1;
  return `cert-${Date.now().toString(36)}-${nextId}`;
}

export function emptyCert(): CertDraft {
  return { id: newCertId(), host: "", kind: "pem", certFile: "", keyFile: "", pfxFile: "", passphrase: "" };
}

export function toDraft(s: AppSettings): SettingsDraft {
  return {
    theme: s.theme,
    layout: s.layout,
    timeoutSeconds: formatSeconds(s.timeoutMs),
    scriptTimeoutSeconds: formatSeconds(s.scriptTimeoutMs),
    followRedirects: s.followRedirects,
    maxRedirects: String(s.maxRedirects),
    verifyTls: s.verifyTls,
    historyRetention: String(s.historyRetention),
    checkForUpdates: s.checkForUpdates,
    proxyMode: s.proxy.mode,
    proxyUrl: s.proxy.url,
    proxyUsername: s.proxy.username,
    proxyBypass: s.proxy.bypass,
    proxyPassword: "",
    clearProxyPassword: false,
    caFile: s.caFile,
    certs: s.clientCerts.map((c) => ({
      id: c.id,
      host: c.host,
      kind: c.pfxFile ? "pfx" : "pem",
      certFile: c.certFile,
      keyFile: c.keyFile,
      pfxFile: c.pfxFile,
      passphrase: "",
    })),
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
const MIN_SCRIPT_S = SETTINGS_LIMITS.minScriptTimeoutMs / 1000;
const MAX_SCRIPT_S = SETTINGS_LIMITS.maxScriptTimeoutMs / 1000;

/** Checks a custom proxy URL like Go's httpexec.ParseProxyURL; returns the problem or null. */
export function proxyUrlError(url: string): string | null {
  const t = url.trim();
  if (t === "") return "Enter the proxy URL, e.g. http://proxy.example.com:8080.";
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(t);
  if (!m || !["http", "https", "socks5", "socks5h"].includes(m[1].toLowerCase()))
    return "Start the URL with http://, https:// or socks5://.";
  if (m[2].includes("@")) return "Put the user name and password in their own fields, not in the URL.";
  if (m[2] === "" || m[2].startsWith(":")) return "Add the proxy's host, e.g. http://proxy.example.com:8080.";
  return null;
}

/** Splits a host list like Go's httpexec.ParseHostList. */
export function hostList(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase().replace(/\.$/, ""))
    .filter((p) => p !== "");
}

const CIDR = /^[0-9a-f.:]+\/\d{1,3}$/i;

/** Checks one host pattern like Go's httpexec.CheckHostPattern; returns the problem or null. */
export function hostPatternError(p: string): string | null {
  if (p === "") return "Enter a host, e.g. api.example.com or *.example.com.";
  if (p.includes("/")) return CIDR.test(p) ? null : `"${p}" isn't a valid IP range (e.g. 10.0.0.0/8).`;
  if (/[\s@?#]/.test(p) || (p.includes(":") && !/^[0-9a-f:]+$/i.test(p)))
    return `"${p}" isn't a host name, wildcard or IP address.`;
  const stars = p.split("*").length - 1;
  if (stars > 1 || (stars === 1 && p !== "*" && !p.startsWith("*.")))
    return `"${p}": a wildcard can only start the pattern, as in *.example.com.`;
  return null;
}

/** Validates the draft; returns settings to save and passwords to store, or the field errors. */
export function fromDraft(
  d: SettingsDraft,
  base: AppSettings,
):
  | { settings: AppSettings; secrets: PendingSecrets; errors: null }
  | { settings: null; secrets: null; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const timeout = parseWhole(d.timeoutSeconds, 0, MAX_TIMEOUT_S);
  if (timeout === null) errors.timeoutSeconds = `Enter whole seconds from 0 to ${MAX_TIMEOUT_S}.`;
  const scriptTimeout = parseWhole(d.scriptTimeoutSeconds, MIN_SCRIPT_S, MAX_SCRIPT_S);
  if (scriptTimeout === null)
    errors.scriptTimeoutSeconds = `Enter whole seconds from ${MIN_SCRIPT_S} to ${MAX_SCRIPT_S}.`;

  let maxRedirects = parseWhole(d.maxRedirects, 1, SETTINGS_LIMITS.maxRedirects);
  if (maxRedirects === null) {
    // Ignored while redirects are off, so keep the saved value instead of blocking.
    if (d.followRedirects) errors.maxRedirects = `Enter a number from 1 to ${SETTINGS_LIMITS.maxRedirects}.`;
    else maxRedirects = base.maxRedirects;
  }

  const retention = parseWhole(d.historyRetention, 0, SETTINGS_LIMITS.maxHistoryRetention);
  if (retention === null)
    errors.historyRetention = `Enter a number from 0 to ${SETTINGS_LIMITS.maxHistoryRetention.toLocaleString("en-US")}.`;

  if (d.proxyMode === "custom") {
    const e = proxyUrlError(d.proxyUrl);
    if (e) errors.proxyUrl = e;
  }
  for (const p of hostList(d.proxyBypass)) {
    const e = hostPatternError(p);
    if (e) {
      errors.proxyBypass = e;
      break;
    }
  }

  const certErrors: Record<string, string> = {};
  const certs: ClientCert[] = [];
  for (const c of d.certs) {
    const host = c.host.trim().toLowerCase();
    const certFile = c.kind === "pem" ? c.certFile.trim() : "";
    const keyFile = c.kind === "pem" ? c.keyFile.trim() : "";
    const pfxFile = c.kind === "pfx" ? c.pfxFile.trim() : "";
    const hostError = hostPatternError(host);
    if (hostError) certErrors[c.id] = hostError;
    else if (c.kind === "pem" && (!certFile || !keyFile))
      certErrors[c.id] = "Choose the certificate file and its key file.";
    else if (c.kind === "pfx" && !pfxFile) certErrors[c.id] = "Choose the PKCS#12 (.p12 or .pfx) file.";
    certs.push({ id: c.id, host, certFile, keyFile, pfxFile });
  }
  if (Object.keys(certErrors).length > 0) errors.certs = certErrors;

  if (Object.keys(errors).length > 0) return { settings: null, secrets: null, errors };

  const secrets: PendingSecrets = { certPassphrases: [] };
  if (d.proxyPassword !== "") secrets.proxyPassword = d.proxyPassword;
  else if (d.clearProxyPassword) secrets.proxyPassword = "";
  for (const c of d.certs) {
    if (c.kind === "pfx" && c.passphrase !== "")
      secrets.certPassphrases.push({ id: c.id, passphrase: c.passphrase });
  }
  return {
    settings: {
      theme: d.theme,
      layout: d.layout,
      timeoutMs: timeout! * 1000,
      followRedirects: d.followRedirects,
      maxRedirects: maxRedirects!,
      verifyTls: d.verifyTls,
      historyRetention: retention!,
      checkForUpdates: d.checkForUpdates,
      proxy: {
        mode: d.proxyMode,
        url: d.proxyUrl.trim(),
        username: d.proxyUsername.trim(),
        bypass: d.proxyBypass,
      },
      caFile: d.caFile.trim(),
      clientCerts: certs,
      scriptTimeoutMs: scriptTimeout! * 1000,
      // Changed through the Webhooks section (it checks the file runs).
      cloudflaredPath: base.cloudflaredPath,
    },
    secrets,
    errors: null,
  };
}

/** True when saving stores or deletes a password (the secret store must be ready first). */
export function hasPendingSecrets(s: PendingSecrets): boolean {
  return s.proxyPassword !== undefined || s.certPassphrases.length > 0;
}

/** True when saving would delete history entries (retention lowered, and not "keep all"). */
export function lowersRetention(draft: SettingsDraft, saved: AppSettings): boolean {
  const next = parseWhole(draft.historyRetention, 0, SETTINGS_LIMITS.maxHistoryRetention);
  if (next === null || next === 0) return false;
  return saved.historyRetention === 0 || next < saved.historyRetention;
}
