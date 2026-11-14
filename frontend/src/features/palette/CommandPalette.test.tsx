import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { useShortcuts } from "@/hooks/useShortcuts";
import { api } from "@/lib/api";
import { emptyRequest, type CollectionNode } from "@/lib/model";
import { findRequest } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import { useExamplesStore } from "@/stores/examples";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore } from "@/stores/palette";
import { useSettingsStore } from "@/stores/settings";
import { useTabsStore } from "@/stores/tabs";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { col, folder, makeEnv, makeExample, makeExampleSummary, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { CommandPalette } from "./CommandPalette";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } };
});

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tree = (): CollectionNode[] => [
  col("c1", "Users API", [
    folder("f1", "Admin", [req("r2", "Delete user", "DELETE", "{{baseUrl}}/users/:id")]),
    req("r1", "List users", "GET", "{{baseUrl}}/users"),
  ]),
  col("c2", "Orders", [req("r3", "Refund order", "POST", "https://shop/refund")]),
];

function seed() {
  const cols = tree();
  useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: cols, treeLoaded: true });
  vi.mocked(api.tree).mockResolvedValue({ collections: cols, problems: [] });
  vi.mocked(api.getRequest).mockImplementation(async (id: string) => ({
    ...emptyRequest(),
    id,
    name: findRequest(cols, id)?.name ?? id,
  }));
  useEnvironmentsStore.setState({
    status: "ready",
    workspaceId: "w1",
    environments: [makeEnv("e1", "Development"), makeEnv("e2", "Production")],
    selectedId: "e1",
  });
  useExamplesStore.setState({
    workspaceId: "w1",
    byRequest: { r1: [makeExampleSummary("x1", "r1", { name: "Happy path" })] },
  });
}

function Shortcuts() {
  useShortcuts();
  return null;
}

function renderPalette(extra?: React.ReactNode) {
  return render(
    <TooltipProvider>
      <Shortcuts />
      {extra}
      <CommandPalette />
    </TooltipProvider>,
  );
}

const pressModK = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: "k", ctrlKey: true });
const input = () => screen.getByRole("combobox");
const options = () => screen.getAllByRole("option");
const option = (name: string | RegExp) => screen.getByRole("option", { name });

async function openWith(text = "") {
  const user = userEvent.setup();
  act(() => usePaletteStore.getState().openPalette());
  const box = await screen.findByRole("combobox");
  if (text) await user.type(box, text);
  return user;
}

beforeEach(() => {
  resetTabs();
  seed();
  useLayoutStore.setState({ sidebarView: "collections" });
});

describe("command palette: opening", () => {
  it("opens and closes with Mod+K, also from inside a code editor, and blocks other shortcuts while open", async () => {
    renderPalette(<CodeEditor ariaLabel="Scratch" value="" onChange={() => {}} />);
    const editor = screen.getByRole("textbox", { name: "Scratch" });
    editor.focus();
    pressModK(editor);
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    pressModK();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });

  it("starts with recent items and open tabs, and explains the keys", async () => {
    localStorage.setItem(
      "pakpos-palette-recent:w1",
      JSON.stringify(["folder:f1", "request:gone", "request:r3"]),
    );
    renderPalette();
    await openWith();
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("Admin"), expect.stringContaining("Refund order")]);
    expect(within(screen.getByRole("group", { name: "Open tabs" })).getByRole("option")).toHaveTextContent(
      "Untitled request",
    );
    expect(screen.getByText(/use environment/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/actions/);
  });
});

describe("command palette: search", () => {
  it("finds requests by name, path or URL and opens one, revealing it in the tree", async () => {
    renderPalette();
    const user = await openWith("user");
    const first = options()[0];
    expect(first).toHaveTextContent("Users API");
    expect(option(/Delete user/)).toHaveTextContent("Users API › Admin");
    expect(option(/Example: Happy path — List users/)).toBeInTheDocument();

    await user.clear(input());
    await user.type(input(), "baseurl");
    // Matched by URL only: both requests, nothing else.
    expect(options().map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Delete user"), expect.stringContaining("List users")]),
    );
    expect(options()).toHaveLength(2);
    await user.clear(input());
    await user.type(input(), "list users");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(activeTab().saved?.id).toBe("r1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "r:r1", focus: true });
    expect(JSON.parse(localStorage.getItem("pakpos-palette-recent:w1")!)).toEqual(["request:r1"]);
  });

  it("reveals and expands a folder, and ranks recently used matches first", async () => {
    localStorage.setItem("pakpos-palette-recent:w1", JSON.stringify(["request:r2"]));
    renderPalette();
    const user = await openWith("user");
    // Both contain "user" in their name; the recent one wins.
    const names = options().map((o) => o.textContent ?? "");
    expect(names.findIndex((n) => n.includes("Delete user"))).toBeLessThan(
      names.findIndex((n) => n.includes("List users")),
    );
    await user.clear(input());
    await user.type(input(), "admin");
    await user.click(option(/^Admin/));
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "f:f1" });
    expect(useTreeStore.getState().states.w1.expanded.has("f:f1")).toBe(true);
  });

  it("opens an environment's editor with Enter and uses it with Mod+Enter", async () => {
    renderPalette();
    const user = await openWith("produc");
    expect(option(/Production/)).toHaveTextContent("Environment");
    await user.keyboard("{Enter}");
    expect(activeTab().doc).toMatchObject({ kind: "environment", targetId: "e2" });

    await openWith("produc");
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.selectEnvironment).toHaveBeenCalledWith("e2"));
    expect(useEnvironmentsStore.getState().selectedId).toBe("e2");

    // Mod+Enter on anything else just opens it.
    await openWith("glob");
    expect(option(/Globals/)).toHaveTextContent("Variables");
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(activeTab().doc?.kind).toBe("globals"));
  });

  it("opens an example: the request opens and shows it", async () => {
    vi.mocked(api.getExample).mockResolvedValue(makeExample("x1", { name: "Happy path" }));
    renderPalette();
    const user = await openWith("happy");
    await user.click(option(/Example: Happy path/));
    await waitFor(() => expect(useExamplesStore.getState().viewing[activeTab().id]?.id).toBe("x1"));
    expect(activeTab().saved?.id).toBe("r1");
    expect(api.getExample).toHaveBeenCalledWith("r1", "x1");
  });

  it("switches to an open tab, and doesn't list a saved request twice", async () => {
    const t2 = useTabsStore
      .getState()
      .openSaved({ ...emptyRequest(), id: "r3", name: "Refund order" }, "c2", "w1");
    act(() => useTabsStore.getState().activate("t1"));
    renderPalette();
    const user = await openWith("refund");
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("Orders");
    await user.clear(input());
    await user.type(input(), "untitled");
    await user.click(option(/Untitled request/));
    expect(useTabsStore.getState().activeId).toBe("t1");
    expect(t2).not.toBe("t1");
  });

  it("lists matching actions too, and explains when nothing matches", async () => {
    renderPalette();
    const user = await openWith("theme");
    expect(
      within(screen.getByRole("group", { name: "Actions" })).getByRole("option", { name: /Toggle theme/ }),
    ).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "zzzz");
    expect(screen.getByText(/Nothing matches “zzzz”/)).toBeInTheDocument();
  });

  it("works without a workspace: open tabs and actions only", async () => {
    useWorkspaceStore.setState({ status: "none", workspace: null, collections: [] });
    renderPalette();
    const user = await openWith("list");
    expect(screen.queryByRole("option", { name: /List users/ })).not.toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "qqq");
    expect(screen.getByText(/Open a workspace to search its requests/)).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "untitled");
    expect(option(/Untitled request/)).toBeInTheDocument();
  });
});

describe("command palette: actions", () => {
  it("lists actions by group with shortcut hints and runs one", async () => {
    const setTheme = vi.spyOn(useSettingsStore.getState(), "setTheme").mockResolvedValue();
    renderPalette();
    const user = await openWith(">");
    expect(screen.getByRole("group", { name: "Requests" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(option(/^Save(?! as)/)).toHaveTextContent(/Ctrl\+S|⌘\+S/);
    expect(screen.queryByRole("option", { name: /Lock secrets/ })).not.toBeInTheDocument();
    await user.type(input(), "toggle th");
    await user.keyboard("{Enter}");
    expect(setTheme).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Recently run actions come first.
    await openWith(">");
    expect(within(screen.getByRole("group", { name: "Recent" })).getByRole("option")).toHaveTextContent(
      "Toggle theme",
    );
    await userEvent.setup().type(input(), "qqqq");
    expect(screen.getByText(/No actions match “qqqq”/)).toBeInTheDocument();
  });

  it("moves the current request through a searchable second step", async () => {
    const saved = { ...emptyRequest(), id: "r1", name: "List users" };
    resetTabs(saved, { saved, parentId: "c1", workspaceId: "w1" });
    vi.mocked(api.moveRequest).mockResolvedValue(saved);
    renderPalette();
    const user = await openWith(">move");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("navigation", { name: "Palette steps" })).toHaveTextContent(
      "Move current request to",
    );
    // The current parent isn't offered.
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining("Admin"),
      expect.stringContaining("Orders"),
    ]);
    await user.type(input(), "ord");
    expect(options()).toHaveLength(1);

    // Backspace on an empty input goes back to the actions.
    await user.clear(input());
    await user.keyboard("{Backspace}");
    expect(input()).toHaveValue(">");
    expect(screen.queryByRole("navigation", { name: "Palette steps" })).not.toBeInTheDocument();

    await user.type(input(), "move");
    await user.keyboard("{Enter}");
    await user.type(input(), "ord");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.moveRequest).toHaveBeenCalledWith("r1", "c2", 1));
  });

  it("switches the environment through a second step; Esc and the back button go back", async () => {
    renderPalette();
    const user = await openWith(">switch env");
    await user.keyboard("{Enter}");
    expect(option(/Development/)).toHaveTextContent("In use");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(input()).toHaveValue(">");

    await user.type(input(), "switch env{Enter}");
    await user.click(screen.getByRole("button", { name: "Back to actions" }));
    expect(input()).toHaveValue(">");

    await user.type(input(), "switch env{Enter}");
    await user.type(input(), "zzz");
    expect(screen.getByText(/No environments match/)).toBeInTheDocument();
    await user.clear(input());
    await user.click(option(/No environment/));
    await waitFor(() => expect(api.selectEnvironment).toHaveBeenCalledWith(""));
  });

  it("explains when there's nowhere to move to", async () => {
    useWorkspaceStore.setState({ collections: [col("c1", "Only", [req("r1")])] });
    const saved = { ...emptyRequest(), id: "r1", name: "r1" };
    resetTabs(saved, { saved, parentId: "c1", workspaceId: "w1" });
    renderPalette();
    const user = await openWith(">move");
    await user.keyboard("{Enter}");
    expect(screen.getByText(/nowhere else to move it/)).toBeInTheDocument();
    await user.type(input(), "x");
    expect(screen.getByText(/No collections or folders match/)).toBeInTheDocument();
  });

  it("asks before clearing history", async () => {
    renderPalette();
    const user = await openWith(">clear hist");
    await user.keyboard("{Enter}");
    const confirm = await screen.findByRole("alertdialog", { name: "Clear history of Shop?" });
    await user.click(within(confirm).getByRole("button", { name: "Clear history" }));
    expect(api.historyClear).toHaveBeenCalled();
  });

  it("reveals the current request without handing focus back to where the palette opened", async () => {
    const saved = { ...emptyRequest(), id: "r2", name: "Delete user" };
    resetTabs(saved, { saved, parentId: "f1", workspaceId: "w1" });
    useLayoutStore.setState({ sidebarView: "history" });
    renderPalette();
    const user = await openWith(">reveal");
    await user.keyboard("{Enter}");
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "r:r2", focus: true });
  });
});

describe("command palette: environment step", () => {
  const selectedOption = () =>
    screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

  it("opens on the environment in use; the keyboard moves on from there", async () => {
    renderPalette();
    const user = await openWith(">switch env");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(selectedOption()).toHaveTextContent(/Development.*In use/));
    await user.keyboard("{ArrowDown}");
    expect(selectedOption()).toHaveTextContent("Production");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.selectEnvironment).toHaveBeenCalledWith("e2"));
  });

  it("highlights No environment when none is in use, and typing filters as usual", async () => {
    useEnvironmentsStore.setState({ selectedId: "" });
    renderPalette();
    const user = await openWith(">switch env");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(selectedOption()).toHaveTextContent(/No environment.*In use/));
    await user.type(input(), "prod");
    await waitFor(() => expect(selectedOption()).toHaveTextContent("Production"));
    // Going back releases the highlight for the actions list.
    await user.clear(input());
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(selectedOption()).toBeDefined());
    await user.type(input(), "toggle th");
    await waitFor(() => expect(selectedOption()).toHaveTextContent("Toggle theme"));
  });
});
