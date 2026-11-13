import { Annotation, EditorState } from "@codemirror/state";

/** Marks changes that came from the `value` prop, so they aren't echoed to onChange. */
export const External = Annotation.define<boolean>();

/** Joins pasted or typed multi-line text into one line. */
export const singleLineFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines <= 1) return tr;
  const text = tr.newDoc.toString().replace(/\s*[\r\n]+\s*/g, "");
  return [
    tr,
    {
      changes: { from: 0, to: tr.newDoc.length, insert: text },
      selection: { anchor: Math.min(tr.newSelection.main.head, text.length) },
      sequential: true,
    },
  ];
});
