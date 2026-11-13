import type { Extension } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";

export type EditorLanguage = "json" | "xml" | "html" | "javascript" | "text";

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
