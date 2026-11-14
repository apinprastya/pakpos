import type { AuthType } from "@/lib/model";

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

/** True for a value typed in as is: not empty and without any `{{variable}}`. */
export function isLiteralSecret(value: string): boolean {
  return value.trim() !== "" && !/\{\{[^{}]+\}\}/.test(value);
}
