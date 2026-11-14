import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SPLIT_A, SPLIT_B, useColumnSplit } from "@/hooks/useColumnSplit";
import { useUiStateStore } from "@/stores/uiState";
import { ColumnResizer } from "./ColumnResizer";

function Table() {
  const split = useColumnSplit("test", 0.4);
  return (
    <div role="table" aria-label="T" style={split.style}>
      <div role="row">
        <span role="columnheader" className="relative" {...SPLIT_A}>
          Key
          <ColumnResizer column="Key" split={split} />
        </span>
        <span role="columnheader" {...SPLIT_B}>
          Value
        </span>
      </div>
    </div>
  );
}

const stored = () => useUiStateStore.getState().values["columns.test"];

function widths(a: number, b: number) {
  const [ha, hb] = screen.getAllByRole("columnheader");
  vi.spyOn(ha, "getBoundingClientRect").mockReturnValue({ width: a } as DOMRect);
  vi.spyOn(hb, "getBoundingClientRect").mockReturnValue({ width: b } as DOMRect);
}

describe("ColumnResizer", () => {
  it("is a labelled, focusable separator reporting the split", () => {
    render(<Table />);
    const sep = screen.getByRole("separator", { name: "Resize Key column" });
    expect(sep).toHaveAttribute("aria-valuenow", "40");
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("tabindex", "0");
  });

  it("steps with the keyboard and resets on double click", async () => {
    const user = userEvent.setup();
    render(<Table />);
    const sep = screen.getByRole("separator", { name: "Resize Key column" });
    sep.focus();
    await user.keyboard("{ArrowRight}");
    expect(stored()).toBe(0.42);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(stored()).toBe(0.32);
    await user.keyboard("{Home}");
    expect(stored()).toBe(0.15);
    await user.keyboard("{End}");
    expect(stored()).toBe(0.85);
    expect(sep).toHaveAttribute("aria-valuenow", "85");
    await user.keyboard("{ArrowLeft}");
    expect(stored()).toBe(0.83);
    await user.keyboard("a");
    expect(stored()).toBe(0.83);

    await user.dblClick(sep);
    expect(stored()).toBeUndefined();
    expect(sep).toHaveAttribute("aria-valuenow", "40");
  });

  it("drags width between the two marked columns", () => {
    render(<Table />);
    widths(200, 300);
    const sep = screen.getByRole("separator", { name: "Resize Key column" });
    fireEvent.pointerMove(sep, { clientX: 999 }); // not dragging
    expect(stored()).toBeUndefined();

    fireEvent.pointerDown(sep, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 150, pointerId: 1 });
    expect(stored()).toBe(0.5); // (200 + 50) / 500
    fireEvent.pointerMove(sep, { clientX: 1000, pointerId: 1 });
    expect(stored()).toBe(0.85);
    fireEvent.pointerUp(sep, { pointerId: 1 });
    fireEvent.pointerUp(sep, { pointerId: 1 }); // already ended
    fireEvent.pointerMove(sep, { clientX: 100, pointerId: 1 });
    expect(stored()).toBe(0.85);
  });

  it("ignores other buttons and unmeasurable tables", () => {
    render(<Table />);
    const sep = screen.getByRole("separator", { name: "Resize Key column" });
    fireEvent.pointerDown(sep, { button: 0, clientX: 100 }); // jsdom: 0×0 cells
    fireEvent.pointerMove(sep, { clientX: 150 });
    expect(stored()).toBeUndefined();

    widths(200, 300);
    fireEvent.pointerDown(sep, { button: 2, clientX: 100 });
    fireEvent.pointerMove(sep, { clientX: 150 });
    expect(stored()).toBeUndefined();

    fireEvent.pointerDown(sep, { button: 0, clientX: 100 });
    fireEvent.pointerCancel(sep);
    fireEvent.pointerMove(sep, { clientX: 150 });
    expect(stored()).toBeUndefined();
  });
});
