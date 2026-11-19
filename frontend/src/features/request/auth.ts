import { emptyOAuth2, type Auth, type AuthType } from "@/lib/model";
import { splitVars } from "@/lib/varTokens";

export const AUTH_LABELS: Record<AuthType, string> = {
  none: "No auth",
  inherit: "Inherit from parent",
  basic: "Basic auth",
  bearer: "Bearer token",
  apikey: "API key",
  oauth2: "OAuth 2.0",
};

/** Auth fields that usually hold a secret (the OAuth 2.0 ones live in `auth.oauth2`). */
export type SecretField = "password" | "token" | "apiValue" | "oauth2ClientSecret" | "oauth2Password";

/** Variable names offered when moving a field's value to a secret. */
export const SUGGESTED_NAMES: Record<SecretField, string> = {
  password: "password",
  token: "token",
  apiValue: "apiKey",
  oauth2ClientSecret: "clientSecret",
  oauth2Password: "password",
};

/** The value of a secret field. */
export function secretFieldValue(auth: Auth, field: SecretField): string {
  switch (field) {
    case "oauth2ClientSecret":
      return auth.oauth2?.clientSecret ?? "";
    case "oauth2Password":
      return auth.oauth2?.password ?? "";
    default:
      return auth[field];
  }
}

/** auth with a secret field set to value. */
export function withSecretField(auth: Auth, field: SecretField, value: string): Auth {
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
