import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/shell/Sidebar";
import { api } from "@/lib/api";
import { emptyRequest, type CollectionNode } from "@/lib/model";
import { activeTab, resetTabs } from "@/test/store";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

const ws = { id: "w1", name: "Shop API", path: "/work/shop" };
const collections = (): CollectionNode[] => [
  {
    id: "c1",
    name: "Users",
    seq: 1,
    requests: [
      { id: "r1", name: "List users", method: "GET", url: "https://api/users", seq: 1 },
      { id: "r2", name: "Create user", method: "POST", url: "https://api/users", seq: 2 },
    ],
  },
  {
    id: "c2",
    name: "Orders",
    seq: 2,
    requests: [{ id: "r3", name: "Delete order", method: "DELETE", url: "https://api/orders/1", seq: 1 }],
  },
  { id: "c3", name: "Empty", seq: 3, requests: [] },
];

function ready(cols = collections(), problems: { path: string; message: string }[] = []) {
  vi.mocked(api.tree).mockResolvedValue({ collections: cols, problems });
  vi.mocked(api.getRequest).mockImplementation(async (id: string) => ({
    ...emptyRequest(),
    id,
    name: cols.flatMap((c) => c.requests).find((r) => r.id === id)?.name ?? id,
  }));
  useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: cols, problems });
}

function renderSidebar() {
  return render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>,
  );
}

const tree = () => screen.getByRole("tree", { name: "Collections" });
const item = (name: string | RegExp) => within(tree()).getByRole("treeitem", { name });

beforeEach(() => {
  resetTabs();
  useLayoutStore.setState({ sidebarView: "collections" });
  localStorage.clear();
});

describe("sidebar: no workspace", () => {
  it("offers to open or create a workspace and lists recent ones", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      status: "none",
      recent: [{ path: "/work/old", name: "Old API", lastOpened: "" }],
    });
    const store = useWorkspaceStore.getState();
    const openFolder = vi.spyOn(store, "openFolder").mockResolvedValue();
    const createInFolder = vi.spyOn(store, "createInFolder").mockResolvedValue();
    const openPath = vi.spyOn(store, "openPath").mockResolvedValue(true);
    renderSidebar();
    expect(screen.getByText("No workspace open")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await user.click(screen.getByRole("button", { name: /Old API/ }));
    expect(openFolder).toHaveBeenCalled();
    expect(createInFolder).toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith("/work/old");
  });

  it("shows a loading state", () => {
    useWorkspaceStore.setState({ status: "loading" });
    renderSidebar();
    expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workspace: Loading/ })).toBeInTheDocument();
  });
});

describe("sidebar: workspace switcher", () => {
  it("switches, removes recent entries, opens, creates and closes", async () => {
    const user = userEvent.setup();
    ready();
    vi.mocked(api.recentWorkspaces).mockResolvedValue([
      { path: "/work/shop", name: "Shop API", lastOpened: "" },
      { path: "/work/old", name: "Old API", lastOpened: "" },
    ]);
    const store = useWorkspaceStore.getState();
    const openPath = vi.spyOn(store, "openPath").mockResolvedValue(true);
    const removeRecent = vi.spyOn(store, "removeRecent").mockResolvedValue();
    const openFolder = vi.spyOn(store, "openFolder").mockResolvedValue();
    const createInFolder = vi.spyOn(store, "createInFolder").mockResolvedValue();
    const close = vi.spyOn(store, "close").mockResolvedValue();
    renderSidebar();

    const trigger = screen.getByRole("button", { name: "Workspace: Shop API. Switch workspace" });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(await within(menu).findByText("Old API")).toBeInTheDocument();
    // The current workspace can't be removed or re-opened.
    expect(within(menu).queryByRole("button", { name: /Remove Shop API/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("button", { name: "Remove Old API from recent workspaces" }));
    expect(removeRecent).toHaveBeenCalledWith("/work/old");
    await user.click(within(menu).getByRole("menuitem", { name: /Shop API/ }));
    expect(openPath).not.toHaveBeenCalled();

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /Old API/ }));
    expect(openPath).toHaveBeenCalledWith("/work/old");

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Open folder…" }));
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Create workspace…" }));
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Close workspace" }));
    expect(openFolder).toHaveBeenCalled();
    expect(createInFolder).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});

describe("sidebar: collections tree", () => {
  it("renders collections and requests and opens a request on click", async () => {
    const user = userEvent.setup();
    ready();
    renderSidebar();
    expect(item("Users")).toHaveAttribute("aria-expanded", "true");
    expect(item("GET List users")).toHaveAttribute("aria-level", "2");
    expect(within(item("Empty")).getByText("No requests yet")).toBeInTheDocument();
    await user.click(within(item("GET List users")).getByText("List users"));
    await waitFor(() => expect(activeTab().saved?.id).toBe("r1"));
    expect(item("GET List users")).toHaveAttribute("aria-selected", "true");
  });

  it("collapses and remembers it per workspace", async () => {
    const user = userEvent.setup();
    ready();
    const { unmount } = renderSidebar();
    await user.click(within(item("Users")).getByText("Users"));
    expect(item("Users")).toHaveAttribute("aria-expanded", "false");
    expect(within(tree()).queryByRole("treeitem", { name: "GET List users" })).not.toBeInTheDocument();
    unmount();
    renderSidebar();
    expect(item("Users")).toHaveAttribute("aria-expanded", "false");
  });

  it("survives broken expansion storage", () => {
    localStorage.setItem("pakpos-tree-collapsed:w1", "{not json");
    ready();
    renderSidebar();
    expect(item("Users")).toHaveAttribute("aria-expanded", "true");
  });

  it("filters by name, URL or method and auto-expands", async () => {
    const user = userEvent.setup();
    ready();
    renderSidebar();
    await user.click(within(item("Users")).getByText("Users")); // collapse
    const filter = screen.getByRole("searchbox", { name: "Filter requests" });
    await user.type(filter, "create");
    expect(item("Users")).toHaveAttribute("aria-expanded", "true");
    expect(item("POST Create user")).toBeInTheDocument();
    expect(within(tree()).queryByRole("treeitem", { name: "Orders" })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "zzz");
    expect(screen.getByText('No requests match "zzz"')).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filter" })[1]);
    expect(filter).toHaveValue("");
    await user.type(filter, "list");
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    await user.type(filter, "y{Escape}");
    expect(filter).toHaveValue("");
  });

  it("supports arrow keys, Enter, F2 rename and Delete", async () => {
    const user = userEvent.setup();
    ready();
    const store = useWorkspaceStore.getState();
    const renameRequest = vi.spyOn(store, "renameRequest").mockResolvedValue();
    const renameCollection = vi.spyOn(store, "renameCollection").mockResolvedValue();
    const deleteRequest = vi.spyOn(store, "deleteRequest").mockResolvedValue();
    const deleteCollection = vi.spyOn(store, "deleteCollection").mockResolvedValue();
    renderSidebar();

    act(() => item("Users").focus());
    await user.keyboard("{ArrowLeft}");
    expect(item("Users")).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowRight}");
    expect(item("Users")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    expect(item("GET List users")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("POST Create user")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(item("Users")).toHaveFocus();
    await user.keyboard("{End}");
    expect(item("Empty")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("Users")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(item("Users")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(item("Users")).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    await waitFor(() => expect(activeTab().saved?.id).toBe("r1"));

    // F2 renames the focused request; Escape cancels, Enter saves.
    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Request name" });
    await user.keyboard("{Escape}");
    expect(input).not.toBeInTheDocument();
    await user.keyboard("{F2}");
    await user.clear(screen.getByRole("textbox", { name: "Request name" }));
    await user.keyboard("Fetch users{Enter}");
    expect(renameRequest).toHaveBeenCalledWith("r1", "Fetch users");

    await user.keyboard("{Delete}");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Delete request "List users"?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete request" }));
    expect(deleteRequest).toHaveBeenCalledWith("r1");

    act(() => item("Users").focus());
    await user.keyboard("{F2}");
    await user.clear(screen.getByRole("textbox", { name: "Collection name" }));
    await user.keyboard("People{Enter}");
    expect(renameCollection).toHaveBeenCalledWith("c1", "People");
    await user.keyboard("{F2}");
    await user.keyboard("{Escape}");

    await user.keyboard("{Delete}");
    const d2 = await screen.findByRole("alertdialog");
    expect(within(d2).getByText(/and 2 requests in it/)).toBeInTheDocument();
    await user.click(within(d2).getByRole("button", { name: "Cancel" }));
    expect(deleteCollection).not.toHaveBeenCalled();

    act(() => item("Empty").focus());
    await user.keyboard("{Delete}");
    const d3 = await screen.findByRole("alertdialog");
    expect(within(d3).getByText(/empty collection/)).toBeInTheDocument();
    await user.click(within(d3).getByRole("button", { name: "Delete collection" }));
    expect(deleteCollection).toHaveBeenCalledWith("c3");

    // Unhandled keys do nothing.
    await user.keyboard("a");
  });

  it("reorders with Alt+Arrow keys, within bounds", async () => {
    const user = userEvent.setup();
    ready();
    const store = useWorkspaceStore.getState();
    const reorderCollections = vi.spyOn(store, "reorderCollections").mockResolvedValue();
    const moveRequest = vi.spyOn(store, "moveRequest").mockResolvedValue();
    renderSidebar();

    act(() => item("Users").focus());
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(reorderCollections).not.toHaveBeenCalled();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(reorderCollections).toHaveBeenCalledWith(["c2", "c1", "c3"]);

    act(() => item("POST Create user").focus());
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(moveRequest).not.toHaveBeenCalled();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(moveRequest).toHaveBeenCalledWith("r2", "c1", 0);
  });

  it("offers actions in the right-click and More menus", async () => {
    const user = userEvent.setup();
    ready();
    const store = useWorkspaceStore.getState();
    const newRequest = vi.spyOn(store, "newRequest").mockResolvedValue();
    const duplicateRequest = vi.spyOn(store, "duplicateRequest").mockResolvedValue();
    const moveRequest = vi.spyOn(store, "moveRequest").mockResolvedValue();
    const openRequest = vi.spyOn(store, "openRequest").mockResolvedValue();
    renderSidebar();

    fireEvent.contextMenu(within(item("Users")).getByText("Users"));
    await user.click(await screen.findByRole("menuitem", { name: "New request" }));
    expect(newRequest).toHaveBeenCalledWith("c1");

    fireEvent.contextMenu(within(item("Users")).getByText("Users"));
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Collection name" })).toHaveValue("Users");
    await user.keyboard("{Escape}");

    fireEvent.contextMenu(within(item("Users")).getByText("Users"));
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    const row = () => within(item("GET List users")).getByText("List users");
    fireEvent.contextMenu(row());
    await user.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(openRequest).toHaveBeenCalledWith("r1");
    fireEvent.contextMenu(row());
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(duplicateRequest).toHaveBeenCalledWith("r1");
    fireEvent.contextMenu(row());
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Request name" })).toHaveValue("List users");
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(row());
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    // "Move to" lists the other collections.
    fireEvent.contextMenu(row());
    await user.click(await screen.findByRole("menuitem", { name: "Move to" }));
    // Submenu pointer "grace areas" need real geometry; select with the keyboard instead.
    act(() => screen.getByRole("menuitem", { name: "Orders" }).focus());
    await user.keyboard("{Enter}");
    expect(moveRequest).toHaveBeenCalledWith("r1", "c2", 1);

    // The hover button opens the same actions.
    await user.click(screen.getByRole("button", { name: "More actions for Delete order" }));
    expect(await screen.findByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
  });

  it("shows 'No other collections' when there is nowhere to move", async () => {
    const user = userEvent.setup();
    ready([collections()[0]]);
    renderSidebar();
    fireEvent.contextMenu(within(item("GET List users")).getByText("List users"));
    await user.click(await screen.findByRole("menuitem", { name: "Move to" }));
    expect(await screen.findByText("No other collections")).toBeInTheDocument();
  });

  it("creates collections from the header and the empty state, then renames the new one", async () => {
    const user = userEvent.setup();
    ready([]);
    const create = vi.spyOn(useWorkspaceStore.getState(), "createCollection").mockResolvedValue("c9");
    renderSidebar();
    expect(screen.getByText("No collections yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create collection" }));
    await user.click(screen.getByRole("button", { name: "New collection" }));
    expect(create).toHaveBeenCalledTimes(2);

    act(() =>
      useWorkspaceStore.setState({
        collections: [{ id: "c9", name: "New collection", seq: 1, requests: [] }],
        renameTarget: "c9",
      }),
    );
    const input = await screen.findByRole("textbox", { name: "Collection name" });
    expect(input).toHaveValue("New collection");
    await user.keyboard("{Escape}");
    expect(useWorkspaceStore.getState().renameTarget).toBeNull();
  });

  it("starts renaming a new request and saves on blur", async () => {
    const user = userEvent.setup();
    ready();
    const rename = vi.spyOn(useWorkspaceStore.getState(), "renameRequest").mockResolvedValue();
    renderSidebar();
    act(() => useWorkspaceStore.setState({ renameTarget: "r3" }));
    const input = await screen.findByRole("textbox", { name: "Request name" });
    await user.clear(input);
    await user.type(input, "Remove order");
    act(() => input.blur());
    expect(rename).toHaveBeenCalledWith("r3", "Remove order");
    // Unknown targets are ignored.
    act(() => useWorkspaceStore.setState({ renameTarget: "ghost" }));
    expect(screen.queryByRole("textbox", { name: /name/ })).not.toBeInTheDocument();
  });

  it("lists files that couldn't be loaded", async () => {
    const user = userEvent.setup();
    ready(collections(), [{ path: "collections/users/bad.yaml", message: "yaml: line 3: bad indent" }]);
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "1 file couldn't be loaded" }));
    expect(await screen.findByText("collections/users/bad.yaml")).toBeInTheDocument();
    expect(screen.getByText("yaml: line 3: bad indent")).toBeInTheDocument();
  });
});
