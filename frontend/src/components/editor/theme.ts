import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Editor chrome driven by CSS tokens, so it follows light/dark automatically. */
export const pakposTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "12.5px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--foreground)", padding: "6px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--editor-selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
    padding: "0 4px",
  },
  ".cm-panels": { backgroundColor: "var(--sidebar)", color: "var(--foreground)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-search": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-search input, .cm-search button": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--card)",
    border: "1px solid var(--input)",
    borderRadius: "4px",
    color: "var(--foreground)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--secondary)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--foreground)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--chart-3) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--primary) 35%, transparent)",
  },
  ".cm-placeholder": { color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
});

export const pakposHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.propertyName, t.attributeName], color: "var(--syntax-key)" },
    { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syntax-keyword)" },
    { tag: [t.tagName, t.typeName], color: "var(--syntax-tag)" },
    { tag: [t.attributeValue], color: "var(--syntax-string)" },
    { tag: [t.comment, t.meta], color: "var(--syntax-comment)", fontStyle: "italic" },
    { tag: [t.punctuation, t.bracket, t.separator, t.angleBracket], color: "var(--syntax-punct)" },
    { tag: [t.variableName, t.definition(t.variableName)], color: "var(--foreground)" },
    { tag: t.function(t.variableName), color: "var(--syntax-key)" },
  ]),
);
