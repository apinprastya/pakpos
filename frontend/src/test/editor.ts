import { act, screen, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

/** Where to look: the whole screen, or within a container (e.g. one table). */
function scope(container?: HTMLElement) {
  return container ? within(container) : screen;
}

/** The CodeMirror view behind an editor, found by its accessible name. */
export function editorView(label: string, container?: HTMLElement): EditorView {
  const content = scope(container).getByRole("textbox", { name: label });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error(`No editor named ${label}`);
  return view;
}

export function editorText(label: string, container?: HTMLElement): string {
  return editorView(label, container).state.doc.toString();
}

/** Replaces the editor's text as if the user typed it. */
export function setEditorText(label: string, text: string, container?: HTMLElement): void {
  const view = editorView(label, container);
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
  });
}

/**
 * Focuses a variable field (`VarInput`: static text until focused) so it
 * turns into an editor, and returns that editor's view.
 */
export function focusField(label: string, container?: HTMLElement): EditorView {
  const el = scope(container).getByRole("textbox", { name: label });
  act(() => el.focus());
  return editorView(label, container);
}

/** Types text at the end of a variable field, as a user would. */
export function typeInField(label: string, text: string, container?: HTMLElement): void {
  const view = focusField(label, container);
  const end = view.state.doc.length;
  act(() => {
    view.dispatch({
      changes: { from: end, insert: text },
      selection: { anchor: end + text.length },
      userEvent: "input.type",
    });
  });
}

/** Replaces a variable field's text, as a user would. */
export function setFieldText(label: string, text: string, container?: HTMLElement): void {
  focusField(label, container);
  setEditorText(label, text, container);
}

/** A variable field's text, whether it's showing static text or an editor. */
export function fieldText(label: string, container?: HTMLElement): string {
  const el = scope(container).getByRole("textbox", { name: label });
  const view = EditorView.findFromDOM(el);
  return view ? view.state.doc.toString() : el.dataset.slot === "var-input" ? fieldStaticText(el) : "";
}

function fieldStaticText(el: HTMLElement): string {
  // The placeholder isn't text; it's only shown when the value is empty.
  const span = el.firstElementChild;
  return span && !span.hasAttribute("data-placeholder") ? (span.textContent ?? "") : "";
}
