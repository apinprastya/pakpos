import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";

/** Languages for request bodies (bundled) and for generated code (loaded on first use). */
export type EditorLanguage =
  "json" | "xml" | "html" | "javascript" | "text" | "shell" | "python" | "go" | "java" | "php";

/** Languages only generated code uses: kept out of the main bundle and imported when first shown. */
const LAZY: Partial<Record<EditorLanguage, () => Promise<Extension>>> = {
  shell: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  go: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go),
  python: async () => (await import("@codemirror/lang-python")).python(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  php: async () => (await import("@codemirror/lang-php")).php(),
};

const loaded = new Map<EditorLanguage, Promise<Extension>>();

export function isLazyLanguage(lang: EditorLanguage): boolean {
  return lang in LAZY;
}

/** Loads a lazy language once; resolves to no highlighting if the chunk fails to load. */
export function loadLanguage(lang: EditorLanguage): Promise<Extension> {
  const load = LAZY[lang];
  if (!load) return Promise.resolve(languageExtension(lang));
  let p = loaded.get(lang);
  if (!p) {
    p = load().catch(() => {
      loaded.delete(lang);
      return [];
    });
    loaded.set(lang, p);
  }
  return p;
}

/** Bundled languages; lazy ones return no highlighting (use `loadLanguage`). */
export function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case "json":
      return json();
    case "xml":
      return xml();
    case "html":
      return html();
    case "javascript":
      return javascript();
    default:
      return [];
  }
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
