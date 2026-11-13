import { render, screen } from "@testing-library/react";
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
});
