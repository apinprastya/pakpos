/** Types for the tools that run in Go (`ToolService`), kept apart from `model.ts`. */

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha384" | "sha512";
export type KeyFormat = "text" | "hex" | "base64";

/** What to digest: `text`, or the file at `filePath` when it's set. `key` is already resolved. */
export interface HashRequest {
  algorithm: HashAlgorithm;
  text: string;
  filePath: string;
  hmac: boolean;
  key: string;
  keyFormat: KeyFormat;
}

export interface HashResult {
  hex: string;
  base64: string;
  /** How many bytes were digested. */
  bytes: number;
}

export function normalizeHashResult(input: unknown): HashResult {
  const r = (input ?? {}) as Partial<HashResult>;
  return { hex: r.hex ?? "", base64: r.base64 ?? "", bytes: r.bytes ?? 0 };
}
