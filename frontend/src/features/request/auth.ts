import type { AuthType } from "@/lib/model";
import { splitVars } from "@/lib/varTokens";

export const AUTH_LABELS: Record<AuthType, string> = {
  none: "No auth",
  inherit: "Inherit from parent",
  basic: "Basic auth",
  bearer: "Bearer token",
  apikey: "API key",
};

/** Auth fields that usually hold a secret. */
export type SecretField = "password" | "token" | "apiValue";

/** Variable names offered when moving a field's value to a secret. */
export const SUGGESTED_NAMES: Record<SecretField, string> = {
  password: "password",
  token: "token",
  apiValue: "apiKey",
};

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
