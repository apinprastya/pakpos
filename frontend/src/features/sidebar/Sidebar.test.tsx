import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/shell/Sidebar";
import { api } from "@/lib/api";
import { emptyRequest, type CollectionNode } from "@/lib/model";
import { findRequest } from "@/lib/tree";
import { col, folder, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

const ws = { id: "w1", name: "Shop API", path: "/work/shop" };
const collections = (): CollectionNode[] => [
  col("c1", "Users", [
    req("r1", "List users", "GET", "https://api/users"),
    req("r2", "Create user", "POST", "https://api/users"),
  ]),
  col("c2", "Orders", [req("r3", "Delete order", "DELETE", "https://api/orders/1")]),
  col("c3", "Empty"),
];

function ready(cols = collections(), problems: { path: string; message: string }[] = []) {
  vi.mocked(api.tree).mockResolvedValue({ collections: cols, problems });
  vi.mocked(api.getRequest).mockImplementation(async (id: string) => ({
    ...emptyRequest(),
    id,
    name: findRequest(cols, id)?.name ?? id,
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

  it("shows the current collection as a disabled destination", async () => {
    const user = userEvent.setup();
    ready([collections()[0]]);
    renderSidebar();
    fireEvent.contextMenu(within(item("GET List users")).getByText("List users"));
    await user.click(await screen.findByRole("menuitem", { name: "Move to" }));
    expect(await screen.findByRole("menuitem", { name: "Users" })).toHaveAttribute("aria-disabled", "true");
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
        collections: [col("c9", "New collection")],
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

describe("sidebar: nested folders", () => {
  // Users[ List users, Auth[ Log in, Tokens[ Refresh ] ], Create user ]  Orders[ Delete order ]
  const nested = (): CollectionNode[] => [
    col("c1", "Users", [
      req("r1", "List users"),
      folder("f1", "Auth", [
        req("r4", "Log in", "POST"),
        folder("f2", "Tokens", [req("r5", "Refresh", "POST")]),
      ]),
      req("r2", "Create user", "POST"),
    ]),
    col("c2", "Orders", [req("r3", "Delete order", "DELETE")]),
    col("c3", "Empty"),
  ];

  it("shows folders collapsed with levels, expands on click and remembers it", async () => {
    const user = userEvent.setup();
    ready(nested());
    const { unmount } = renderSidebar();
    expect(item("Auth")).toHaveAttribute("aria-level", "2");
    expect(item("Auth")).toHaveAttribute("aria-expanded", "false");
    expect(item("Auth")).toHaveAttribute("aria-posinset", "2");
    expect(within(item("Auth")).getByText("2")).toBeInTheDocument(); // requests inside, at any depth
    expect(within(tree()).queryByRole("treeitem", { name: "POST Log in" })).not.toBeInTheDocument();

    await user.click(within(item("Auth")).getByText("Auth"));
    expect(item("POST Log in")).toHaveAttribute("aria-level", "3");
    await user.click(within(item("Tokens")).getByText("Tokens"));
    expect(item("POST Refresh")).toHaveAttribute("aria-level", "4");
    unmount();
    renderSidebar();
    expect(item("Tokens")).toHaveAttribute("aria-expanded", "true");
    expect(JSON.parse(localStorage.getItem("pakpos-tree:w1")!)).toEqual({
      collapsed: [],
      expanded: ["f:f1", "f:f2"],
    });
  });

  it("reads the Tier 1 collapsed list", () => {
    localStorage.setItem("pakpos-tree-collapsed:w1", JSON.stringify(["c1"]));
    ready(nested());
    renderSidebar();
    expect(item("Users")).toHaveAttribute("aria-expanded", "false");
  });

  it("filters into folders: a match shows its folders expanded; a folder name shows the folder", async () => {
    const user = userEvent.setup();
    ready(nested());
    renderSidebar();
    const filter = screen.getByRole("searchbox", { name: "Filter requests" });
    await user.type(filter, "refresh");
    expect(item("Auth")).toHaveAttribute("aria-expanded", "true");
    expect(item("POST Refresh")).toBeInTheDocument();
    expect(within(tree()).queryByRole("treeitem", { name: "POST Log in" })).not.toBeInTheDocument();
    await user.clear(filter);
    await user.type(filter, "tokens");
    expect(item("Tokens")).toBeInTheDocument();
    expect(within(tree()).queryByRole("treeitem", { name: "GET List users" })).not.toBeInTheDocument();
  });

  it("navigates folders with the keyboard and reorders them with Alt+arrows", async () => {
    const user = userEvent.setup();
    ready(nested());
    const store = useWorkspaceStore.getState();
    const moveFolder = vi.spyOn(store, "moveFolder").mockResolvedValue();
    const renameFolder = vi.spyOn(store, "renameFolder").mockResolvedValue();
    const deleteFolder = vi.spyOn(store, "deleteFolder").mockResolvedValue();
    renderSidebar();

    act(() => item("Auth").focus());
    await user.keyboard("{ArrowRight}");
    expect(item("Auth")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    expect(item("POST Log in")).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(item("Tokens")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(item("Tokens")).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowLeft}");
    expect(item("Auth")).toHaveFocus();
    await user.keyboard("{ArrowLeft}"); // collapses Auth
    expect(item("Auth")).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowLeft}"); // then goes to its parent
    expect(item("Users")).toHaveFocus();

    act(() => item("Auth").focus());
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(moveFolder).toHaveBeenCalledWith("f1", "c1", 0);
    await user.keyboard("{ArrowRight}");
    act(() => item("Tokens").focus());
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(moveFolder).toHaveBeenCalledTimes(1); // already last in Auth

    await user.keyboard("{F2}");
    await user.clear(screen.getByRole("textbox", { name: "Folder name" }));
    await user.keyboard("Sessions{Enter}");
    expect(renameFolder).toHaveBeenCalledWith("f2", "Sessions");

    await user.keyboard("{Delete}");
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByText('Delete folder "Tokens"?')).toBeInTheDocument();
    expect(within(d).getByText(/the folder and 1 request in it/)).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Delete folder" }));
    expect(deleteFolder).toHaveBeenCalledWith("f2");
  });

  it("offers new folder, new request and nested move targets in the menus", async () => {
    const user = userEvent.setup();
    ready(nested());
    const store = useWorkspaceStore.getState();
    const createFolder = vi.spyOn(store, "createFolder").mockResolvedValue("f9");
    const newRequest = vi.spyOn(store, "newRequest").mockResolvedValue();
    const moveFolder = vi.spyOn(store, "moveFolder").mockResolvedValue();
    const moveRequest = vi.spyOn(store, "moveRequest").mockResolvedValue();
    renderSidebar();

    fireEvent.contextMenu(within(item("Users")).getByText("Users"));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    expect(createFolder).toHaveBeenCalledWith("c1");

    const auth = () => within(item("Auth")).getByText("Auth");
    fireEvent.contextMenu(auth());
    await user.click(await screen.findByRole("menuitem", { name: "New request" }));
    expect(newRequest).toHaveBeenCalledWith("f1");
    expect(item("Auth")).toHaveAttribute("aria-expanded", "true");
    fireEvent.contextMenu(auth());
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    expect(createFolder).toHaveBeenLastCalledWith("f1");
    fireEvent.contextMenu(auth());
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Auth");
    await user.keyboard("{Escape}");

    // A folder can't move into itself: its subtree isn't offered, its parent is disabled.
    fireEvent.contextMenu(auth());
    await user.click(await screen.findByRole("menuitem", { name: "Move to" }));
    expect(screen.getByRole("menuitem", { name: "Users" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Users / Auth / Tokens" })).not.toBeInTheDocument();
    act(() => screen.getByRole("menuitem", { name: "Orders" }).focus());
    await user.keyboard("{Enter}");
    expect(moveFolder).toHaveBeenCalledWith("f1", "c2", 1);

    // A request can move into a nested folder.
    fireEvent.contextMenu(within(item("GET List users")).getByText("List users"));
    await user.click(await screen.findByRole("menuitem", { name: "Move to" }));
    act(() => screen.getByRole("menuitem", { name: "Users / Auth / Tokens" }).focus());
    await user.keyboard("{Enter}");
    expect(moveRequest).toHaveBeenCalledWith("r1", "f2", 1);

    // Deleting an empty folder says so.
    fireEvent.contextMenu(auth());
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    expect(
      within(await screen.findByRole("alertdialog")).getByText(/and 2 requests in it/),
    ).toBeInTheDocument();
  });

  it("shows an empty folder and starts renaming a new one", async () => {
    const user = userEvent.setup();
    ready([col("c1", "Users", [folder("f1", "Docs")])]);
    localStorage.setItem("pakpos-tree:w1", JSON.stringify({ collapsed: [], expanded: ["f:f1"] }));
    const deleteFolder = vi.spyOn(useWorkspaceStore.getState(), "deleteFolder").mockResolvedValue();
    const rename = vi.spyOn(useWorkspaceStore.getState(), "renameFolder").mockResolvedValue();
    renderSidebar();
    expect(within(item("Docs")).getByText("Empty folder")).toBeInTheDocument();
    act(() => item("Docs").focus());
    await user.keyboard("{Delete}");
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByText(/the empty folder/)).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Delete folder" }));
    expect(deleteFolder).toHaveBeenCalledWith("f1");

    act(() => useWorkspaceStore.setState({ renameTarget: "f1" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    await user.clear(input);
    await user.type(input, "Guides{Enter}");
    expect(rename).toHaveBeenCalledWith("f1", "Guides");
  });
});
