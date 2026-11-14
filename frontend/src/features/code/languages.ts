import { api } from "@/lib/api";
import type { CodeLanguage } from "@/lib/model";

let languagesCache: Promise<CodeLanguage[]> | null = null;

/** The generators Go offers; fetched once per session. */
export function codeLanguages(): Promise<CodeLanguage[]> {
  languagesCache ??= api.codeLanguages().catch((e: unknown) => {
    languagesCache = null;
    throw e;
  });
  return languagesCache;
}

/** Test hook: forget the cached language list. */
export function resetCodeLanguages() {
  languagesCache = null;
}
