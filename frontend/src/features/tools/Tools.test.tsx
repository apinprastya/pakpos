import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { api } from "@/lib/api";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore } from "@/stores/palette";
import { useTabsStore } from "@/stores/tabs";
import { activeTab, resetTabs } from "@/test/store";
import { availableActions, oauth2Target, type ActionContext } from "@/features/palette/actions";
import { buildItems } from "@/features/palette/search";

const s = () => useTabsStore.getState();
const tabList = () => screen.getByRole("tablist", { name: "Open tabs" });

beforeEach(() => {
  resetTabs();
  useLayoutStore.setState({ sidebarView: "collections" });
});

describe("tools view and tool tabs", () => {
  it("lists the tools in the Tools view and opens one tab per tool", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(useLayoutStore.getState().sidebarView).toBe("tools");
    const list = screen.getByRole("list", { name: "Tools" });
    const jwt = within(list).getByRole("button", { name: /JWT decoder/ });
    expect(jwt).toHaveTextContent("Read a token's header, payload and expiry.");

    await user.click(jwt);
    expect(within(tabList()).getByRole("tab", { name: "JWT decoder" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByRole("heading", { name: "JWT decoder" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /JWT decoder/ })).toHaveAttribute("aria-current", "page");

    await user.click(within(tabList()).getAllByRole("tab")[0]);
    await user.click(within(list).getByRole("button", { name: /JWT decoder/ }));
    expect(within(tabList()).getAllByRole("tab")).toHaveLength(2);
    expect(activeTab().tool?.id).toBe("jwt");

    await user.click(within(tabList()).getByRole("button", { name: "Close JWT decoder" }));
    expect(within(tabList()).getAllByRole("tab")).toHaveLength(1);
  });

  it("ignores request shortcuts on a tool tab", async () => {
    render(<App />);
    act(() => void s().openTool("jwt"));
    await screen.findByRole("heading", { name: "JWT decoder" });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true, shiftKey: true });
    expect(api.save).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(s().saveDialog).toBeNull();
    expect(useCodeDialogsStore.getState().codeTabId).toBeNull();
  });

  it("explains a tool this build doesn't know and offers to close it", async () => {
    const user = userEvent.setup();
    resetTabs({}, { id: "x", tool: { id: "regex", state: null } });
    render(<App />);
    expect(within(tabList()).getByRole("tab", { name: "Unknown tool" })).toBeInTheDocument();
    expect(screen.getByText("This tool isn't available")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    expect(s().tabs.some((t) => t.id === "x")).toBe(false);
  });

  it("opens a tool from the palette", async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => usePaletteStore.getState().openPalette());
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const box = within(palette).getByRole("combobox");
    await user.type(box, ">jwt");
    await user.click(await screen.findByRole("option", { name: /Open JWT decoder/ }));
    expect(activeTab().tool?.id).toBe("jwt");
    expect(await screen.findByRole("heading", { name: "JWT decoder" })).toBeInTheDocument();
  });
});

describe("palette with a tool tab", () => {
  const ctx = (): ActionContext => ({
    tab: activeTab(),
    workspace: { id: "w", name: "ws", path: "/ws" },
    secrets: null,
    goTo: () => {},
    confirm: () => {},
  });

  it("hides request-only actions and lists the tab without a method", () => {
    s().openTool("jwt");
    const ids = availableActions(ctx()).map((a) => a.id);
    for (const hidden of [
      "save",
      "save-as",
      "copy-curl",
      "generate-code",
      "open-prerequest-script",
      "reveal-request",
    ]) {
      expect(ids).not.toContain(hidden);
    }
    expect(ids).toContain("open-tool-jwt");
    expect(oauth2Target(activeTab())).toBeNull();
    const items = buildItems({
      collections: [],
      environments: [],
      examples: [],
      tabs: s().tabs,
    } as unknown as Parameters<typeof buildItems>[0]);
    const tab = items.find((i) => i.value === `tab:${activeTab().id}`)!;
    expect(tab.label).toBe("JWT decoder");
    expect(tab.url).toBeUndefined();
    expect(tab.method).toBeUndefined();
  });
});
