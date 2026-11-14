import type { SecretsStatus } from "@/lib/model";

export const MIN_PASSWORD_LENGTH = 8;

export type Strength = "too-short" | "weak" | "fair" | "strong";

/** A rough strength hint for a new master password (length and character variety). */
export function passwordStrength(password: string): { strength: Strength; label: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { strength: "too-short", label: `Too short: use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const long = password.length >= 12;
  if (long && classes >= 3) return { strength: "strong", label: "Strong password." };
  if (long || classes >= 3) {
    return { strength: "fair", label: "Fair. A longer password with mixed characters is stronger." };
  }
  return { strength: "weak", label: "Weak. Use 12 or more characters, or mix letters, digits and symbols." };
}

/** Problems with a new password and its confirmation, or null when it can be used. */
export function newPasswordError(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return "The passwords don't match. Type the same password twice.";
  return null;
}

/** Plain-language state of the encrypted file store. */
export function fileStoreState(status: SecretsStatus): { label: string; action: string } {
  if (!status.hasPassword) return { label: "No master password set", action: "Set a master password" };
  if (status.locked) return { label: "Secrets locked", action: "Unlock secrets" };
  return { label: "Secrets unlocked", action: "Lock secrets" };
}
