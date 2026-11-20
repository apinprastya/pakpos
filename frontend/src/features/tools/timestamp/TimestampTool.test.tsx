import { useEffect, useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { restoreTimestampState, type TimestampState } from "./state";
import { systemZone } from "./timestamp";
import { TimestampTool } from "./TimestampTool";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let current: TimestampState;

function Host({ initial }: { initial: Partial<TimestampState> }) {
  const [state, setState] = useState<TimestampState>(() => restoreTimestampState({ ...initial }));
  useEffect(() => {
    current = state;
  }, [state]);
  return (
    <TooltipProvider>
      <TimestampTool tabId="t" state={state} update={(fn) => setState(fn)} />
    </TooltipProvider>
  );
}

function renderTool(initial: Partial<TimestampState> = {}) {
  render(<Host initial={{ zone: "UTC", ...initial }} />);
}

const input = () => screen.getByRole("textbox", { name: "Timestamp" });
const value = (label: string) => {
  const row = within(screen.getByRole("region", { name: "Formats" })).getByRole("rowheader", { name: label });
  return row.closest("tr")!.querySelector("td")!.textContent;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("timestamp converter", () => {
  it("shows what to do while empty, then converts as you type", async () => {
    const user = userEvent.setup();
    renderTool();
    expect(screen.getByRole("heading", { name: "Timestamp converter" })).toBeInTheDocument();
    expect(
      screen.getByText("Type or paste a timestamp, or press Now. Every format shows here."),
    ).toBeInTheDocument();
    await user.type(input(), "1700000000123");
    expect(
      screen.getByText("Read as Unix milliseconds (picked from the number's size)."),
    ).toBeInTheDocument();
    expect(value("Unix seconds")).toBe("1700000000.123");
    expect(value("RFC 3339, UTC")).toBe("2023-11-14T22:13:20.123Z");
    expect(value("HTTP date (RFC 1123)")).toBe("Tue, 14 Nov 2023 22:13:20 GMT");
    expect(value("Relative")).toBe("3 years ago");
    expect(current.input).toBe("1700000000123");
  });

  it.each<[string, string, string]>([
    ["2026-11-20T19:00:00+07:00", "Read as RFC 3339 / ISO 8601.", "1795176000"],
    ["Sun, 06 Nov 1994 08:49:37 GMT", "Read as an HTTP date (RFC 1123).", "784111777"],
    [
      "1795176000000000001",
      "Read as Unix nanoseconds (picked from the number's size).",
      "1795176000.000000001",
    ],
  ])("reads %j", (text, detected, seconds) => {
    renderTool({ input: text });
    expect(screen.getByText(detected)).toBeInTheDocument();
    expect(value("Unix seconds")).toBe(seconds);
  });

  it("reads numbers in a chosen unit", async () => {
    const user = userEvent.setup();
    renderTool({ input: "1700000000" });
    await user.click(screen.getByRole("combobox", { name: "Read numbers as" }));
    await user.click(await screen.findByRole("option", { name: "Milliseconds" }));
    expect(current.unit).toBe("ms");
    expect(screen.getByText("Read as Unix milliseconds.")).toBeInTheDocument();
    expect(value("RFC 3339, UTC")).toBe("1970-01-20T16:13:20.000Z");
  });

  it("fills in now and clears", async () => {
    const user = userEvent.setup();
    renderTool();
    await user.click(screen.getByRole("button", { name: "Now" }));
    expect(input()).toHaveValue(String(NOW / 1000));
    expect(value("Relative")).toBe("now");
    await user.click(screen.getByRole("button", { name: "Clear timestamp" }));
    expect(input()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Clear timestamp" })).toBeDisabled();
  });

  it("shows the zoned formats in the chosen time zone", async () => {
    const user = userEvent.setup();
    renderTool({ input: "2026-11-20T12:00:00Z" });
    expect(value("RFC 3339, UTC")).toBe("2026-11-20T12:00:00Z");
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.click(await screen.findByRole("option", { name: "Asia/Jakarta" }));
    expect(current.zone).toBe("Asia/Jakarta");
    expect(value("RFC 3339 in Asia/Jakarta")).toBe("2026-11-20T19:00:00+07:00");
    expect(value("Local time in Asia/Jakarta")).toContain("7:00:00");
  });

  it("defaults to the system zone and stores it as empty", async () => {
    const user = userEvent.setup();
    renderTool({ zone: "", input: "0" });
    const zone = systemZone();
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveTextContent(`${zone} (this computer)`);
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.click(await screen.findByRole("option", { name: zone === "UTC" ? "Asia/Tokyo" : "UTC" }));
    expect(current.zone).not.toBe("");
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.click(await screen.findByRole("option", { name: `${zone} (this computer)` }));
    expect(current.zone).toBe("");
  });

  it("explains input it can't read", async () => {
    renderTool({ input: "{{now}}" });
    expect(screen.getByRole("alert")).toHaveTextContent("This isn't a time Pakpos can read.");
    expect(screen.queryByRole("region", { name: "Formats" })).not.toBeInTheDocument();
  });

  it("copies a format", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderTool({ input: "0" });
    await user.click(screen.getByRole("button", { name: "Copy RFC 3339, UTC" }));
    expect(writeText).toHaveBeenCalledWith("1970-01-01T00:00:00Z");
    expect(toast.success).toHaveBeenCalledWith("RFC 3339, UTC copied");
    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy Unix seconds" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy", expect.anything()));
  });
});
