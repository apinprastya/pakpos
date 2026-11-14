import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUiStateStore } from "@/stores/uiState";
import { KeyValueTable } from "./KeyValueTable";
import { FormDataTable } from "./FormDataTable";

describe("table column widths", () => {
  it("key/value tables share a remembered split", async () => {
    const user = userEvent.setup();
    useUiStateStore.setState({ values: { "columns.keyValue": 0.3 } });
    render(
      <>
        <KeyValueTable label="Query parameters" rows={[]} onChange={() => {}} />
        <KeyValueTable label="Headers" rows={[]} onChange={() => {}} keyPlaceholder="Header" />
      </>,
    );
    const tables = screen.getAllByRole("table");
    for (const t of tables) {
      expect(t.style.getPropertyValue("--col-a")).toBe("0.3fr");
      expect(t.style.getPropertyValue("--col-b")).toBe("0.7fr");
    }
    screen.getByRole("separator", { name: "Resize Header column" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(useUiStateStore.getState().values["columns.keyValue"]).toBe(0.32);
    expect(tables[0].style.getPropertyValue("--col-a")).toBe("0.32fr");
  });

  it("form data fields keep their own split", async () => {
    const user = userEvent.setup();
    render(<FormDataTable rows={[]} onChange={() => {}} />);
    const table = screen.getByRole("table", { name: "Form fields" });
    expect(table.style.getPropertyValue("--col-a")).toBe("0.4fr");
    screen.getByRole("separator", { name: "Resize Key column" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(useUiStateStore.getState().values).toEqual({ "columns.formData": 0.38 });
  });
});
