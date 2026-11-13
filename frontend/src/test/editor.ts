import { act, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

/** The CodeMirror view behind an editor, found by its accessible name. */
export function editorView(label: string): EditorView {
  const content = screen.getByRole("textbox", { name: label });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error(`No editor named ${label}`);
  return view;
}

export function editorText(label: string): string {
  return editorView(label).state.doc.toString();
}

/** Replaces the editor's text as if the user typed it. */
export function setEditorText(label: string, text: string): void {
  const view = editorView(label);
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
  });
}
