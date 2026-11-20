import { useEffect, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { editorText } from "@/test/editor";
import { IdsTool } from "./IdsTool";
import { idsInitialState, type IdsState } from "./state";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const NOW = Date.UTC(2022, 1, 22, 19, 22, 22);
/** The host's latest state, for assertions. */
const latest = { current: idsInitialState() };

function Host({ initial }: { initial: IdsState }) {
  const [state, setState] = useState(initial);
  useEffect(() => {
    latest.current = state;
  });
  return (
    <TooltipProvider>
      <IdsTool tabId="t" state={state} update={(fn) => setState((s) => fn(s))} />
    </TooltipProvider>
  );
}

function renderTool(patch: Partial<IdsState> = {}) {
  const user = userEvent.setup();
  render(<Host initial={{ ...idsInitialState(), ...patch }} />);
  return user;
}

const lines = () => editorText("Generated IDs").split("\n");
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("ID generator", () => {
  it("starts with one UUID v4 and regenerates on request", async () => {
    const user = renderTool();
    expect(screen.getByRole("heading", { name: "ID generator" })).toBeInTheDocument();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(screen.getByRole("heading", { name: "1 ID" })).toBeInTheDocument();
    const first = lines()[0];
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(lines()[0]).not.toBe(first);
  });

  it("switches kinds and formats without making new IDs", async () => {
    const user = renderTool({ count: "3" });
    await user.click(radio("Kind", "UUID v7"));
    expect(lines()).toHaveLength(3);
    for (const l of lines()) expect(l).toMatch(/^017f22e2-79b0-7/);
    const v7 = lines();

    await user.click(radio("Case", "Upper case"));
    await user.click(screen.getByRole("checkbox", { name: "Hyphens" }));
    expect(lines()).toEqual(v7.map((l) => l.replace(/-/g, "").toUpperCase()));
    expect(latest.current).toMatchObject({ kind: "uuid7", upper: true, hyphens: false });

    await user.click(radio("Kind", "ULID"));
    expect(screen.queryByRole("checkbox", { name: "Hyphens" })).not.toBeInTheDocument();
    for (const l of lines()) expect(l).toMatch(/^01FWHE4YDG[0-9A-HJKMNP-TV-Z]{16}$/);
    await user.click(radio("Case", "Lower case"));
    for (const l of lines()) expect(l).toMatch(/^01fwhe4ydg/);
  });

  it("validates the count and keeps the last batch meanwhile", async () => {
    const user = renderTool();
    const count = screen.getByRole("textbox", { name: "How many" });
    await user.clear(count);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter how many IDs to generate, from 1 to 1,000.");
    expect(count).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(lines()).toHaveLength(1);

    await user.type(count, "1001");
    expect(screen.getByRole("alert")).toHaveTextContent("You can generate up to 1,000 IDs at a time.");
    await user.type(count, "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(lines()).toHaveLength(100);
    expect(screen.getByRole("heading", { name: "100 IDs" })).toBeInTheDocument();
  });

  it("copies the IDs", async () => {
    const user = renderTool({ count: "2" });
    // After userEvent.setup(), which installs its own clipboard.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy IDs" }));
    expect(writeText).toHaveBeenCalledWith(editorText("Generated IDs"));
    expect(toast.success).toHaveBeenCalledWith("2 IDs copied");

    await user.clear(screen.getByRole("textbox", { name: "How many" }));
    await user.type(screen.getByRole("textbox", { name: "How many" }), "1");
    await user.click(screen.getByRole("button", { name: "Copy IDs" }));
    expect(toast.success).toHaveBeenLastCalledWith("ID copied");

    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy IDs" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the IDs", expect.anything());
  });

  it("inspects a pasted UUID or ULID", async () => {
    const user = renderTool({ inspect: "017F22E2-79B0-7CC3-98C4-DC0C0C07398F" });
    const dl = () => screen.getByLabelText("ID details");
    expect(within(dl()).getByText("Version 7 (Unix time)")).toBeInTheDocument();
    expect(within(dl()).getByText("RFC 9562")).toBeInTheDocument();
    expect(within(dl()).getByText("2022-02-22T19:22:22.000Z")).toBeInTheDocument();
    expect(within(dl()).getByText(new Date(NOW).toLocaleString())).toBeInTheDocument();

    const field = screen.getByRole("textbox", { name: "Inspect an ID" });
    await user.clear(field);
    expect(screen.queryByLabelText("ID details")).not.toBeInTheDocument();
    await user.type(field, "01ARYZ6S41F66H2K2F8E0A4GGT");
    expect(within(dl()).getByText("ULID")).toBeInTheDocument();
    expect(within(dl()).queryByText("Version")).not.toBeInTheDocument();
    expect(latest.current.inspect).toBe("01ARYZ6S41F66H2K2F8E0A4GGT");

    await user.type(field, "X");
    expect(screen.getByRole("alert")).toHaveTextContent("This isn't a UUID or a ULID.");
  });
});
