import { act, render, screen, waitFor } from "@testing-library/react";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { makeScope } from "@/lib/variables";
import { makePreviewVar } from "@/test/fixtures";
import { useState } from "react";
import { editorText, editorView, setEditorText } from "@/test/editor";
import { CodeEditor } from "./CodeEditor";
import { tooltipParent } from "./extensions";
import { showVariableInfo } from "./variables";
import { language as languageFacet } from "@codemirror/language";
import { needsLoading, preloadLanguages } from "./languages";

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

  it("keeps read-only text selectable and focusable", () => {
    render(<CodeEditor ariaLabel="Ed" value="copy me" readOnly />);
    const content = editorView("Ed").contentDOM;
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(content).toHaveAttribute("aria-readonly", "true");
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

  it("shows plain text until its language has loaded, then highlights", async () => {
    // Nothing else in this file uses HTML, so its chunk hasn't loaded yet.
    expect(needsLoading("html")).toBe(true);
    render(<CodeEditor ariaLabel="Ed" value="<p>hi</p>" language="html" />);
    const view = editorView("Ed");
    expect(view.state.facet(languageFacet)).toBeNull();
    await waitFor(() => expect(view.state.facet(languageFacet)?.name).toBe("html"));
    expect(editorText("Ed")).toBe("<p>hi</p>");
  });

  it("uses an already loaded language from the first render", async () => {
    await preloadLanguages(["javascript"]);
    render(<CodeEditor ariaLabel="Ed" value="let a = 1" language="javascript" />);
    expect(editorView("Ed").state.facet(languageFacet)?.name).toBe("javascript");
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

  it("shows tooltips outside the editor, so surrounding panes can't clip them", async () => {
    const scope = makeScope([makePreviewVar("host", "dev.example")], null, true);
    render(
      <div style={{ overflow: "hidden" }} data-testid="pane">
        <CodeEditor ariaLabel="Ed" value="{{host}}" variables={scope} initialCursor={3} />
      </div>,
    );
    const view = editorView("Ed");
    act(() => void showVariableInfo(view));
    await waitFor(() => expect(document.querySelector(".cm-tooltip.var-info")).not.toBeNull());
    const tip = document.querySelector(".cm-tooltip.var-info")!;
    expect(screen.getByTestId("pane")).not.toContainElement(tip as HTMLElement);
    // The container carries the editor's theme classes, so the tooltip keeps its styling.
    expect(tip.parentElement).toHaveClass(...view.themeClasses.split(" "));
  });

  it("keeps tooltips inside the dialog an editor sits in", () => {
    document.body.innerHTML = '<div role="dialog"><p id="in"></p></div><p id="out"></p>';
    expect(tooltipParent(document.getElementById("in")!)).toBe(document.querySelector('[role="dialog"]'));
    expect(tooltipParent(document.getElementById("out")!)).toBe(document.body);
    document.body.innerHTML = "";
  });
});
