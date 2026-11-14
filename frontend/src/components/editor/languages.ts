import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

/** Languages for request and response bodies and for generated code. */
export type EditorLanguage =
  "json" | "xml" | "html" | "javascript" | "text" | "shell" | "python" | "go" | "java" | "php";

/**
 * Every language except plain text is a separate chunk, imported on first use,
 * so none of them weigh on startup. Editors show plain text until it arrives.
 */
const LOADERS: Record<Exclude<EditorLanguage, "text">, () => Promise<Extension>> = {
  json: async () => (await import("@codemirror/lang-json")).json(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  shell: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  go: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go),
  python: async () => (await import("@codemirror/lang-python")).python(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  php: async () => (await import("@codemirror/lang-php")).php(),
};

const loading = new Map<EditorLanguage, Promise<Extension>>();
const ready = new Map<EditorLanguage, Extension>();

/** True when `lang` still has to be loaded before `languageExtension` can highlight it. */
export function needsLoading(lang: EditorLanguage): boolean {
  return lang !== "text" && !ready.has(lang);
}

/** Loads a language once; resolves to no highlighting if the chunk fails to load (and retries next time). */
export function loadLanguage(lang: EditorLanguage): Promise<Extension> {
  if (lang === "text") return Promise.resolve([]);
  let p = loading.get(lang);
  if (!p) {
    p = LOADERS[lang]().then(
      (ext) => {
        ready.set(lang, ext);
        return ext;
      },
      () => {
        loading.delete(lang);
        return [];
      },
    );
    loading.set(lang, p);
  }
  return p;
}

/** The language if it has loaded already; otherwise no highlighting (use `loadLanguage`). */
export function languageExtension(lang: EditorLanguage): Extension {
  return ready.get(lang) ?? [];
}

/** Loads the given languages (tests call it so editors highlight on first render). */
export async function preloadLanguages(langs: EditorLanguage[]): Promise<void> {
  await Promise.all(langs.map(loadLanguage));
}

/** Maps a generator's editor id (from Go) to an editor language; unknown ids are plain text. */
export function editorLanguage(id: string): EditorLanguage {
  const known: EditorLanguage[] = [
    "json",
    "xml",
    "html",
    "javascript",
    "shell",
    "python",
    "go",
    "java",
    "php",
  ];
  return (known as string[]).includes(id) ? (id as EditorLanguage) : "text";
}
