import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ScriptConsoleEvent } from "@/lib/model";
import { useShortcuts } from "@/hooks/useShortcuts";
import { StatusBar } from "@/features/shell/StatusBar";
import { useConsoleStore } from "@/stores/console";
import { makeConsoleEntry, makeResponse, makeResult, makeScriptSource } from "@/test/fixtures";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { ConsolePanel } from "./ConsolePanel";
import { filterGroups, sourceLabel } from "./consoleFilter";
import { useConsoleSync } from "./useConsoleSync";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const s = () => useConsoleStore.getState();

function seed() {
  s().begin("a", { method: "POST", name: "Login" });
  s().finish(
    "a",
    makeResult({
      response: makeResponse({ statusCode: 200, statusText: "OK" }),
      console: [
        makeConsoleEntry("token set"),
        makeConsoleEntry("careful", { level: "warn" }),
        makeConsoleEntry("broken", {
          level: "error",
          source: makeScriptSource({ kind: "folder", name: "Auth", event: "test" }),
        }),
      ],
    }),
  );
}

function renderDrawer() {
  return render(
    <TooltipProvider>
      <ConsoleDrawer />
    </TooltipProvider>,
  );
}

describe("ConsoleDrawer", () => {
  it("tells what to do when there's no output", () => {
    renderDrawer();
    expect(screen.getByText(/Script output shows here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("shows each send's lines under a header, filters by level and text, copies and clears", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    seed();
    renderDrawer();
    const group = screen.getByRole("group", { name: "POST Login" });
    expect(within(group).getByText("200 OK")).toBeInTheDocument();
    expect(within(group).getByText("token set")).toBeInTheDocument();
    expect(within(group).getByText("Test · folder Auth")).toBeInTheDocument();
    expect(within(group).getByLabelText("warn")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Warnings" }));
    expect(screen.getByRole("button", { name: "Warnings" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("careful")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search the console" }), "nothing");
    expect(screen.getByText(/No lines match/)).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search the console" }));
    await user.type(screen.getByRole("searchbox", { name: "Search the console" }), "TOKEN");
    expect(screen.getByText("token set")).toBeInTheDocument();
    expect(screen.queryByText("broken")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy line" }));
    expect(writeText).toHaveBeenCalledWith("token set");
    expect(toast.success).toHaveBeenCalledWith("Copied");
    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy line" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy", expect.anything());

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(s().groups).toEqual([]);
  });

  it("shows a running send as sending, and closes", async () => {
    const user = userEvent.setup();
    s().setOpen(true);
    s().begin("live", { method: "GET", name: "Users" });
    s().append("live", [makeConsoleEntry("hello", { level: "info" })]);
    renderDrawer();
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close console" }));
    expect(s().open).toBe(false);
  });

  it("helpers", () => {
    expect(sourceLabel(makeScriptSource({ kind: "collection", name: "Users" }))).toBe(
      "Pre-request · collection Users",
    );
    seed();
    expect(filterGroups(s().groups, new Set(["error"]), "")[0].lines.map((l) => l.text)).toEqual(["broken"]);
    expect(filterGroups(s().groups, new Set(), "")).toEqual([]);
  });
});

describe("console toggle", () => {
  it("opens from the status bar with the unread count, and loads the drawer", async () => {
    const user = userEvent.setup();
    seed();
    render(
      <TooltipProvider>
        <ConsolePanel>
          <p>editors</p>
        </ConsolePanel>
        <StatusBar />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("region", { name: "Console" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show console (3 new lines)" }));
    expect(await screen.findByRole("region", { name: "Console" })).toBeInTheDocument();
    expect(screen.getByText("editors")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide console" })).toHaveAttribute("aria-pressed", "true");
    act(() => {
      s().setOpen(false);
      s().begin("b", { method: "GET", name: "B" });
      s().append("b", [makeConsoleEntry("one")]);
    });
    expect(screen.getByRole("button", { name: "Show console (1 new line)" })).toBeInTheDocument();
  });

  it("toggles with Mod+J", async () => {
    const user = userEvent.setup();
    renderHook(() => useShortcuts());
    await user.keyboard("{Control>}j{/Control}");
    expect(s().open).toBe(true);
    await user.keyboard("{Control>}j{/Control}");
    expect(s().open).toBe(false);
  });

  it("feeds live events into the store", () => {
    let listener: ((ev: ScriptConsoleEvent) => void) | undefined;
    vi.mocked(api.onScriptConsole).mockImplementation((cb) => {
      listener = cb;
      return () => {};
    });
    renderHook(() => useConsoleSync());
    s().begin("x", { method: "GET", name: "X" });
    act(() => listener!({ sendId: "x", entries: [makeConsoleEntry("live")] }));
    expect(s().groups[0].lines.map((l) => l.text)).toEqual(["live"]);
  });
});
