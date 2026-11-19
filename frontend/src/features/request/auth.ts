import { AUTH_BLOCKS, emptyOAuth2, type Auth, type AuthType, type BlockAuthType } from "@/lib/model";
import { splitVars } from "@/lib/varTokens";

export const AUTH_LABELS: Record<AuthType, string> = {
  none: "No auth",
  inherit: "Inherit from parent",
  basic: "Basic auth",
  bearer: "Bearer token",
  apikey: "API key",
  oauth2: "OAuth 2.0",
  digest: "Digest auth",
  awsv4: "AWS Signature v4",
  jwt: "JWT bearer",
  hawk: "Hawk",
  ntlm: "NTLM",
};

/** Auth fields that usually hold a secret (the OAuth 2.0 ones live in `auth.oauth2`). */
export type SecretField =
  | "password"
  | "token"
  | "apiValue"
  | "oauth2ClientSecret"
  | "oauth2Password"
  | "digestPassword"
  | "awsSecretKey"
  | "awsSessionToken"
  | "jwtSecret"
  | "hawkKey"
  | "ntlmPassword";

/** Where the secret fields of the other auth types live: their block and key. */
const BLOCK_FIELDS: Partial<Record<SecretField, [BlockAuthType, string]>> = {
  digestPassword: ["digest", "password"],
  awsSecretKey: ["awsv4", "secretKey"],
  awsSessionToken: ["awsv4", "sessionToken"],
  jwtSecret: ["jwt", "secret"],
  hawkKey: ["hawk", "key"],
  ntlmPassword: ["ntlm", "password"],
};

/** Variable names offered when moving a field's value to a secret. */
export const SUGGESTED_NAMES: Record<SecretField, string> = {
  password: "password",
  token: "token",
  apiValue: "apiKey",
  oauth2ClientSecret: "clientSecret",
  oauth2Password: "password",
  digestPassword: "password",
  awsSecretKey: "awsSecretKey",
  awsSessionToken: "awsSessionToken",
  jwtSecret: "jwtSecret",
  hawkKey: "hawkKey",
  ntlmPassword: "password",
};

/** The value of a secret field. */
export function secretFieldValue(auth: Auth, field: SecretField): string {
  const block = BLOCK_FIELDS[field];
  if (block) {
    const settings = auth[block[0]] as Record<string, unknown> | undefined;
    return (settings?.[block[1]] as string | undefined) ?? "";
  }
  switch (field) {
    case "oauth2ClientSecret":
      return auth.oauth2?.clientSecret ?? "";
    case "oauth2Password":
      return auth.oauth2?.password ?? "";
    default:
      return auth[field as "password" | "token" | "apiValue"];
  }
}

/** auth with a secret field set to value. */
export function withSecretField(auth: Auth, field: SecretField, value: string): Auth {
  const block = BLOCK_FIELDS[field];
  if (block) {
    const [type, key] = block;
    return { ...auth, [type]: { ...(auth[type] ?? AUTH_BLOCKS[type]()), [key]: value } };
  }
  switch (field) {
    case "oauth2ClientSecret":
      return { ...auth, oauth2: { ...(auth.oauth2 ?? emptyOAuth2()), clientSecret: value } };
    case "oauth2Password":
      return { ...auth, oauth2: { ...(auth.oauth2 ?? emptyOAuth2()), password: value } };
    default:
      return { ...auth, [field]: value };
  }
}

/**
 * True for a value typed in as is: not empty, without any `{{variable}}`,
 * and not a reference being typed (`{{tok`).
 */
export function isLiteralSecret(value: string): boolean {
  return value.trim() !== "" && !/\{\{[^{}]+\}\}/.test(value) && !isReferenceOnly(value);
}

/**
 * True when a secret field holds only `{{references}}`, or is being typed
 * as one (`{{`, `{{tok`): it's shown as a variable field, not masked. A
 * trailing unterminated `{{…` counts, so typing doesn't flip modes midway.
 */
export function isReferenceOnly(value: string): boolean {
  if (!value.startsWith("{{")) return false;
  const parts = splitVars(value);
  return parts.every(
    (p, i) =>
      p.token !== null || (i === parts.length - 1 && p.text.startsWith("{{") && !p.text.includes("}}")),
  );
}
