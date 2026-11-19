import type { HashAlgorithm, HashRequest, KeyFormat } from "@/lib/toolModel";
import type { HashToolState } from "./state";

export const ALGORITHMS: { id: HashAlgorithm; label: string; insecure: boolean }[] = [
  { id: "md5", label: "MD5", insecure: true },
  { id: "sha1", label: "SHA-1", insecure: true },
  { id: "sha256", label: "SHA-256", insecure: false },
  { id: "sha384", label: "SHA-384", insecure: false },
  { id: "sha512", label: "SHA-512", insecure: false },
];

export const KEY_FORMATS: { id: KeyFormat; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "hex", label: "Hex" },
  { id: "base64", label: "Base64" },
];

/** True for the algorithms kept only for checksums. */
export function isInsecure(id: HashAlgorithm): boolean {
  return ALGORITHMS.find((a) => a.id === id)?.insecure ?? false;
}

/** The last part of a path, on any OS. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * The request for Go: the tab's text, or its file in File mode. `key` is the
 * HMAC key with its variables resolved ("" without HMAC).
 */
export function hashRequest(state: HashToolState, key: string): HashRequest {
  const file = state.source === "file";
  return {
    algorithm: state.algorithm,
    text: file ? "" : state.text,
    filePath: file ? state.filePath : "",
    hmac: state.hmac,
    key: state.hmac ? key : "",
    keyFormat: state.keyFormat,
  };
}

/** "1 byte", "2,048 bytes". */
export function byteCount(n: number): string {
  return n === 1 ? "1 byte" : `${n.toLocaleString("en-US")} bytes`;
}
