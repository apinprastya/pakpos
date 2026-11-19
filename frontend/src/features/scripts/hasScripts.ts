import type { Scripts } from "@/lib/model";

/** True when a request, folder or collection has any script. */
export function hasScripts(s: Scripts): boolean {
  return s.preRequest.trim() !== "" || s.test.trim() !== "";
}
