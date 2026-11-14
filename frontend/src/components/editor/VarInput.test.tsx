import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { makePreviewVar } from "@/test/fixtures";
import { editorView, fieldText, focusField, typeInField } from "@/test/editor";
import { makeScope } from "@/lib/variables";
import { VarInput } from "./VarInput";
import { VarScopeContext } from "./varScopeContext";

const scope = makeScope([makePreviewVar("host", "dev")], null, true);

function Host({ initial = "", onEnter }: { initial?: string; onEnter?: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <VarScopeContext.Provider value={scope}>
      <VarInput
        ariaLabel="Value"
        placeholder="Value"
        value={v}
        onChange={setV}
        onEnter={onEnter}
        dataRow={0}
        dataCol="value"
      />
      <button type="button">Elsewhere</button>
    </VarScopeContext.Provider>
  );
}

const editors = () => document.querySelectorAll(".cm-editor").length;

describe("VarInput", () => {
  it("shows static highlighted text until focused", () => {
    render(<Host initial="https://{{host}}/{{nope}}" />);
    const cell = screen.getByRole("textbox", { name: "Value" });
    expect(editors()).toBe(0);
    expect(cell).toHaveAttribute("data-row", "0");
    expect(cell.querySelector(".var-resolved")).toHaveTextContent("{{host}}");
    expect(cell.querySelector(".var-unresolved")).toHaveTextContent("{{nope}}");
    expect(fieldText("Value")).toBe("https://{{host}}/{{nope}}");
  });

  it("marks a variable whose value uses an undefined one in the static text", () => {
    render(
      <VarScopeContext.Provider value={makeScope([makePreviewVar("url", "{{nope}}/x")], null, true)}>
        <VarInput ariaLabel="Nested" value="{{url}}/{{$guid}}" onChange={() => {}} />
      </VarScopeContext.Provider>,
    );
    const cell = screen.getByRole("textbox", { name: "Nested" });
    expect(cell.querySelector(".var-warn")).toHaveTextContent("{{url}}");
    expect(cell.querySelector(".var-dynamic")).toHaveTextContent("{{$guid}}");
  });

  it("shows the placeholder when empty", () => {
    render(<Host />);
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveTextContent("Value");
    expect(fieldText("Value")).toBe("");
  });

  it("becomes an editor on focus, with the caret at the end, and text again on blur", async () => {
    const onEnter = vi.fn();
    render(<Host initial="ab" onEnter={onEnter} />);
    const view = focusField("Value");
    expect(editors()).toBe(1);
    expect(view.state.selection.main.head).toBe(2);
    expect(view.hasFocus).toBe(true);
    typeInField("Value", "{{host}}");
    expect(fieldText("Value")).toBe("ab{{host}}");
    expect(view.contentDOM.querySelector(".var-resolved")).toHaveTextContent("{{host}}");

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onEnter).toHaveBeenCalled();

    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    // CodeMirror reports focus changes after a short timeout.
    await waitFor(() => expect(editors()).toBe(0));
    expect(fieldText("Value")).toBe("ab{{host}}");
  });

  it("puts the caret where the text was clicked", () => {
    render(<Host initial="hello" />);
    const cell = screen.getByRole("textbox", { name: "Value" });
    const text = cell.querySelector("span")!.firstChild!;
    const doc = document as unknown as { caretRangeFromPoint?: () => unknown };
    doc.caretRangeFromPoint = () => ({ startContainer: text, startOffset: 2 });
    try {
      fireEvent.mouseDown(cell, { clientX: 5, clientY: 5 });
      act(() => cell.focus());
      expect(editorView("Value").state.selection.main.head).toBe(2);
    } finally {
      delete doc.caretRangeFromPoint;
    }
  });

  it("works without a scope provider", () => {
    render(<VarInput ariaLabel="Lonely" value="{{x}}" onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Lonely" }).querySelector(".var-unresolved")).not.toBeNull();
  });
});
