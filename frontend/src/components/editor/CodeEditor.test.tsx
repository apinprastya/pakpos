import { act, render, screen, waitFor } from "@testing-library/react";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { makeScope } from "@/lib/variables";
import { makePreviewVar } from "@/test/fixtures";
import { useState } from "react";
import { editorText, editorView, setEditorText } from "@/test/editor";
import { CodeEditor } from "./CodeEditor";
import { languageExtension } from "./languages";

describe("CodeEditor", () => {
  it("reports user edits but not external value changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeEditor ariaLabel="Ed" value="a" onChange={onChange} language="json" />);
    setEditorText("Ed", "b");
    expect(onChange).toHaveBeenCalledWith("b");
    onChange.mockClear();
    rerender(<CodeEditor ariaLabel="Ed" value="external" onChange={onChange} language="xml" />);
    expect(editorText("Ed")).toBe("external");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles read-only", () => {
    const { rerender } = render(<CodeEditor ariaLabel="Ed" value="x" readOnly />);
    expect(editorView("Ed").state.readOnly).toBe(true);
    rerender(<CodeEditor ariaLabel="Ed" value="x" readOnly={false} />);
    expect(editorView("Ed").state.readOnly).toBe(false);
  });

  it("single-line mode strips newlines and submits on Enter", () => {
    const onSubmit = vi.fn();
    function Host() {
      const [v, setV] = useState("");
      return (
        <CodeEditor
          ariaLabel="Url"
          singleLine
          value={v}
          onChange={setV}
          onSubmit={onSubmit}
          placeholder="Type"
        />
      );
    }
    render(<Host />);
    setEditorText("Url", "a\nb");
    expect(editorText("Url")).toBe("ab");
    editorView("Url").contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onSubmit).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Url" })).toBeInTheDocument();
  });

  it("calls onView with the view and null on unmount", () => {
    const onView = vi.fn();
    const { unmount } = render(<CodeEditor ariaLabel="Ed" value="" onView={onView} gutters={false} />);
    expect(onView).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.anything() }));
    unmount();
    expect(onView).toHaveBeenLastCalledWith(null);
  });

  it("maps every language", () => {
    for (const l of ["json", "xml", "html", "javascript", "text"] as const) {
      expect(languageExtension(l)).toBeDefined();
    }
  });

  it("focuses on mount with the cursor where asked", () => {
    render(<CodeEditor ariaLabel="Ed" value="hello" singleLine autoFocus initialCursor={2} />);
    const view = editorView("Ed");
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(2);
  });

  it("reports blur, but not when the whole window lost focus", async () => {
    const onBlur = vi.fn();
    render(
      <>
        <CodeEditor ariaLabel="Ed" value="x" singleLine autoFocus onBlur={onBlur} />
        <button type="button">Other</button>
      </>,
    );
    const spy = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => screen.getByRole("button").focus());
    await new Promise((r) => setTimeout(r, 30));
    expect(onBlur).not.toHaveBeenCalled();
    spy.mockRestore();
    act(() => editorView("Ed").focus());
    await waitFor(() => expect(editorView("Ed").hasFocus).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    act(() => screen.getByRole("button").focus());
    await waitFor(() => expect(onBlur).toHaveBeenCalledTimes(1));
  });

  it("updates variables without a new editor, and Enter picks a completion instead of submitting", async () => {
    const onSubmit = vi.fn();
    const scope = makeScope([], null, true);
    const { rerender } = render(
      <CodeEditor ariaLabel="Url" singleLine value="{{host}}" onSubmit={onSubmit} variables={scope} />,
    );
    const view = editorView("Url");
    expect(view.contentDOM.querySelector(".var-unresolved")).not.toBeNull();
    rerender(
      <CodeEditor
        ariaLabel="Url"
        singleLine
        value="{{host}}"
        onSubmit={onSubmit}
        variables={makeScope([makePreviewVar("host", "h")], null, true)}
      />,
    );
    expect(editorView("Url")).toBe(view);
    expect(view.contentDOM.querySelector(".var-resolved")).not.toBeNull();

    act(() => view.dispatch({ changes: { from: 8, insert: "/{{ho" }, selection: { anchor: 13 } }));
    act(() => void startCompletion(view));
    await waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(completionStatus(view.state)).toBe("active");
    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("{{host}}/{{host}}");
    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
