import { render, screen, within } from "@testing-library/react";
import { WarningList } from "./WarningList";

const w = (message: string) => ({ option: "", message });

describe("WarningList", () => {
  it("shows the first three warnings and counts the rest", () => {
    const { rerender } = render(<WarningList warnings={[w("a"), w("b"), w("c"), w("d"), w("e")]} />);
    let items = within(screen.getByRole("list", { name: "Import warnings" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["a", "b", "c", "2 more warnings"]);

    rerender(<WarningList warnings={[w("a"), w("b"), w("c"), w("d")]} />);
    items = screen.getAllByRole("listitem");
    expect(items.at(-1)).toHaveTextContent("1 more warning");

    rerender(<WarningList warnings={[w("only")]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
