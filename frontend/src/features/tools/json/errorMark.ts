import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Marks the error at an offset (null clears it). */
export const setErrorMark = StateEffect.define<number | null>();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrorMark)) continue;
      if (e.value === null) {
        deco = Decoration.none;
        continue;
      }
      const len = tr.state.doc.length;
      const from = Math.min(Math.max(e.value, 0), len);
      const line = tr.state.doc.lineAt(from);
      const ranges = [Decoration.line({ class: "cm-error-line" }).range(line.from)];
      if (from < line.to) ranges.push(Decoration.mark({ class: "cm-error-mark" }).range(from, from + 1));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** An editor extension that shows where a parse error is: the line tinted, the character underlined. */
export const errorMarks = [
  errorField,
  EditorView.baseTheme({
    // Translucent, so the selection drawn beneath stays visible.
    ".cm-error-line": { backgroundColor: "color-mix(in oklab, var(--destructive) 10%, transparent)" },
    ".cm-error-mark": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
  }),
];
