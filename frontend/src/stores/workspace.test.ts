import { toast } from "sonner";
import { api } from "@/lib/api";
import { emptyRequest, type CollectionNode, type FolderNode, type Request } from "@/lib/model";
import { col as fcol, folder as ffolder, req as freq } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { useTabsStore } from "./tabs";
import { useWorkspaceStore } from "./workspace";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    }),
  };
});

const ws = { id: "w1", name: "API", path: "/work/api" };
const s = () => useWorkspaceStore.getState();
const tabs = () => useTabsStore.getState().tabs;
const req = (id: string, extra: Partial<Request> = {}): Request => ({
  ...emptyRequest(),
  id,
  name: `Req ${id}`,
  url: `https://x/${id}`,
  ...extra,
});
const col = (id: string, reqIds: string[], folders: FolderNode[] = []): CollectionNode =>
  fcol(id, `Col ${id}`, [...reqIds.map((r) => freq(r, `Req ${r}`, "GET", `https://x/${r}`)), ...folders]);
const fold = (id: string, reqIds: string[], folders: FolderNode[] = []): FolderNode =>
  ffolder(id, `Folder ${id}`, [
    ...reqIds.map((r) => freq(r, `Req ${r}`, "GET", `https://x/${r}`)),
    ...folders,
  ]);

function mockTree(collections: CollectionNode[], problems = [] as { path: string; message: string }[]) {
  vi.mocked(api.tree).mockResolvedValue({ collections, problems });
}

async function openReady(collections: CollectionNode[] = [col("c1", ["r1", "r2"]), col("c2", [])]) {
  mockTree(collections);
  vi.mocked(api.currentWorkspace).mockResolvedValue(ws);
  vi.mocked(api.getRequest).mockImplementation(async (id: string) => req(id));
  await s().init();
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.success).mockClear();
  resetTabs();
});

describe("workspace store: opening", () => {
  it("init restores the current workspace and loads the tree", async () => {
    await openReady();
    expect(s()).toMatchObject({ status: "ready", workspace: ws });
    expect(s().collections.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("init falls back to the most recent workspace, then to none", async () => {
    vi.mocked(api.recentWorkspaces).mockResolvedValue([{ path: "/old", name: "Old", lastOpened: "" }]);
    vi.mocked(api.openWorkspace).mockResolvedValue({ id: "w9", name: "Old", path: "/old" });
    await s().init();
    expect(api.openWorkspace).toHaveBeenCalledWith("/old");
    expect(s().workspace?.id).toBe("w9");

    vi.mocked(api.openWorkspace).mockRejectedValue(new Error("gone"));
    await s().init();
    expect(s()).toMatchObject({ status: "none", workspace: null });
  });

  it("init reports errors and ends with no workspace", async () => {
    vi.mocked(api.currentWorkspace).mockRejectedValue(new Error("db down"));
    await s().init();
    expect(s().status).toBe("none");
    expect(toast.error).toHaveBeenCalledWith("Couldn't load the workspace", { description: "db down" });
  });

  it("loadRecent tolerates errors", async () => {
    vi.mocked(api.recentWorkspaces).mockRejectedValue(new Error("x"));
    await s().loadRecent();
    expect(s().recent).toEqual([]);
  });

  it("openPath offers to create a workspace in a plain folder", async () => {
    vi.mocked(api.openWorkspace).mockRejectedValue(
      new Error("not a pakpos workspace: /p has no pakpos.yaml"),
    );
    vi.mocked(api.createWorkspace).mockResolvedValue({ id: "w2", name: "p", path: "/p" });
    expect(await s().openPath("/p")).toBe(false);
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(title).toBe("This folder isn't a workspace yet");
    opts.action.onClick();
    await vi.waitFor(() => expect(s().workspace?.id).toBe("w2"));
    expect(toast.success).toHaveBeenCalledWith("Workspace created");
  });

  it("openPath reports other errors", async () => {
    vi.mocked(api.openWorkspace).mockRejectedValue(new Error("permission denied"));
    expect(await s().openPath("/p")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the workspace", {
      description: "permission denied",
    });
  });

  it("openFolder and createInFolder use the folder picker; cancel does nothing", async () => {
    await s().openFolder();
    await s().createInFolder();
    expect(api.openWorkspace).not.toHaveBeenCalled();
    expect(api.createWorkspace).not.toHaveBeenCalled();

    vi.mocked(api.pickFolder).mockResolvedValue("/new");
    vi.mocked(api.openWorkspace).mockResolvedValue(ws);
    await s().openFolder();
    expect(s().workspace).toEqual(ws);

    // Creating where a workspace already exists just opens it.
    vi.mocked(api.createWorkspace).mockRejectedValue(new Error("a workspace already exists here: /new"));
    await s().createInFolder();
    expect(api.openWorkspace).toHaveBeenLastCalledWith("/new");

    vi.mocked(api.createWorkspace).mockRejectedValue(new Error("disk full"));
    await s().createInFolder();
    expect(toast.error).toHaveBeenCalledWith("Couldn't create the workspace", { description: "disk full" });

    vi.mocked(api.pickFolder).mockRejectedValue(new Error("no dialog"));
    await s().openFolder();
    await s().createInFolder();
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the folder picker", { description: "no dialog" });
  });

  it("openOrCreate opens, or creates when the folder isn't a workspace", async () => {
    vi.mocked(api.openWorkspace).mockResolvedValueOnce(ws);
    await s().openOrCreate("/work/api");
    expect(s().workspace).toEqual(ws);

    vi.mocked(api.openWorkspace).mockRejectedValueOnce(new Error("not a pakpos workspace"));
    vi.mocked(api.createWorkspace).mockResolvedValue({ id: "w3", name: "n", path: "/n" });
    await s().openOrCreate("/n");
    expect(s().workspace?.id).toBe("w3");

    vi.mocked(api.openWorkspace).mockRejectedValueOnce(new Error("boom"));
    await s().openOrCreate("/z");
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the workspace", { description: "boom" });
  });

  it("close clears the workspace; failures keep it", async () => {
    await openReady();
    vi.mocked(api.closeWorkspace).mockRejectedValueOnce(new Error("busy"));
    await s().close();
    expect(s().workspace).toEqual(ws);
    await s().close();
    expect(s()).toMatchObject({ status: "none", workspace: null, collections: [] });
  });

  it("removeRecent drops the entry; failures are reported", async () => {
    useWorkspaceStore.setState({
      recent: [
        { path: "/a", name: "A", lastOpened: "" },
        { path: "/b", name: "B", lastOpened: "" },
      ],
    });
    await s().removeRecent("/a");
    expect(s().recent.map((r) => r.path)).toEqual(["/b"]);
    vi.mocked(api.removeRecent).mockRejectedValue(new Error("x"));
    await s().removeRecent("/b");
    expect(s().recent).toHaveLength(1);
    expect(toast.error).toHaveBeenCalled();
  });
});

describe("workspace store: tabs follow the workspace", () => {
  it("switching workspace closes clean tabs from the old one and keeps edited ones unsaved", async () => {
    const clean = req("r1");
    useTabsStore.setState({
      tabs: [
        {
          id: "a",
          request: clean,
          saved: clean,
          parentId: "c1",
          workspaceId: "old",
          sendId: null,
          result: null,
          doc: null,
        },
        {
          id: "b",
          request: { ...req("r2"), url: "https://edited" },
          saved: req("r2"),
          parentId: "c1",
          workspaceId: "old",
          sendId: null,
          result: null,
          doc: null,
        },
      ],
      activeId: "a",
    });
    await openReady();
    expect(tabs().map((t) => t.id)).toEqual(["b"]);
    expect(tabs()[0].saved).toBeNull();
    expect(toast.info).toHaveBeenCalledWith("1 request with unsaved edits kept open", expect.anything());
  });

  it("external changes: deleted files detach tabs, changed files reload clean tabs", async () => {
    await openReady();
    const r1 = req("r1");
    const r2 = req("r2");
    useTabsStore.setState({
      tabs: [
        {
          id: "a",
          request: r1,
          saved: r1,
          parentId: "c1",
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
        {
          id: "b",
          request: { ...r2, url: "https://mine" },
          saved: r2,
          parentId: "c1",
          workspaceId: "",
          sendId: null,
          result: null,
          doc: null,
        },
        {
          id: "c",
          request: r1,
          saved: r1,
          parentId: "c1",
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
      ],
      activeId: "a",
    });
    // r1 moved to c2 and changed on disk; r2 changed on disk while tab b has edits.
    mockTree([col("c1", ["r2"]), col("c2", ["r1"])], [{ path: "bad.yaml", message: "oops" }]);
    vi.mocked(api.getRequest).mockImplementation(async (id: string) =>
      req(id, { url: `https://disk/${id}` }),
    );
    await s().handleChange({ workspaceId: "w1", problems: [{ path: "bad.yaml", message: "oops" }] });

    const [a, b] = tabs();
    expect(a.request.url).toBe("https://disk/r1");
    expect(a.parentId).toBe("c2");
    expect(b.request.url).toBe("https://mine");
    expect(b.saved?.url).toBe("https://disk/r2");
    expect(b.workspaceId).toBe("w1");
    expect(s().problems).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledWith('"Req r2" changed on disk', expect.anything());

    // Now r1 is deleted on disk: both tabs showing it are detached.
    mockTree([col("c1", ["r2"])]);
    await s().handleChange({ workspaceId: "w1", problems: [] });
    expect(
      tabs()
        .filter((t) => t.saved === null)
        .map((t) => t.id),
    ).toEqual(["a", "c"]);
    expect(toast.warning).toHaveBeenCalledWith(
      "2 open requests were deleted from the workspace",
      expect.anything(),
    );

    mockTree([]);
    await s().handleChange({ workspaceId: "w1", problems: [] });
    expect(toast.warning).toHaveBeenCalledWith('"Req r2" was deleted from the workspace', expect.anything());
  });

  it("ignores changes for other workspaces and unreadable files", async () => {
    await openReady();
    vi.mocked(api.tree).mockClear();
    await s().handleChange({ workspaceId: "other", problems: [] });
    expect(api.tree).not.toHaveBeenCalled();

    const r1 = req("r1");
    useTabsStore.setState({
      tabs: [
        {
          id: "a",
          request: r1,
          saved: r1,
          parentId: "c1",
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
      ],
      activeId: "a",
    });
    vi.mocked(api.getRequest).mockRejectedValue(new Error("mid-write"));
    await s().handleChange({ workspaceId: "w1", problems: [] });
    expect(tabs()[0].saved).toEqual(r1);
  });

  it("refresh reports tree errors and does nothing without a workspace", async () => {
    await s().refresh();
    expect(api.tree).not.toHaveBeenCalled();
    await openReady();
    vi.mocked(api.tree).mockRejectedValue(new Error("io"));
    await s().refresh();
    expect(toast.error).toHaveBeenCalledWith("Couldn't load the workspace", { description: "io" });
  });
});

describe("workspace store: collections and requests", () => {
  beforeEach(async () => {
    await openReady();
  });

  it("createCollection refreshes and starts renaming it", async () => {
    vi.mocked(api.createCollection).mockResolvedValue({ id: "c9", name: "New collection" });
    expect(await s().createCollection()).toBe("c9");
    expect(api.createCollection).toHaveBeenCalledWith("New collection");
    expect(s().renameTarget).toBe("c9");
    s().setRenameTarget(null);
    expect(s().renameTarget).toBeNull();

    vi.mocked(api.createCollection).mockRejectedValue(new Error("x"));
    expect(await s().createCollection("Y")).toBeNull();
  });

  it("renameCollection skips blank or unchanged names and reports errors", async () => {
    await s().renameCollection("c1", "  ");
    await s().renameCollection("c1", "Col c1");
    await s().renameCollection("missing", "Z");
    expect(api.renameCollection).not.toHaveBeenCalled();
    await s().renameCollection("c1", " Users ");
    expect(api.renameCollection).toHaveBeenCalledWith("c1", "Users");
    vi.mocked(api.renameCollection).mockRejectedValue(new Error("exists"));
    await s().renameCollection("c1", "Other");
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename the collection", { description: "exists" });
  });

  it("deleteCollection closes clean tabs of its requests and keeps edited ones", async () => {
    const r1 = req("r1");
    const r2 = req("r2");
    useTabsStore.setState({
      tabs: [
        {
          id: "a",
          request: r1,
          saved: r1,
          parentId: "c1",
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
        {
          id: "b",
          request: { ...r2, url: "https://edit" },
          saved: r2,
          parentId: "c1",
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
      ],
      activeId: "a",
    });
    mockTree([col("c2", [])]);
    await s().deleteCollection("c1");
    expect(api.deleteCollection).toHaveBeenCalledWith("c1");
    expect(tabs().map((t) => [t.id, t.saved])).toEqual([["b", null]]);
    expect(toast.success).toHaveBeenCalledWith("Collection deleted");

    vi.mocked(api.deleteCollection).mockRejectedValue(new Error("x"));
    await s().deleteCollection("c2");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the collection", { description: "x" });
  });

  it("reorderCollections applies the order optimistically", async () => {
    vi.mocked(api.reorderCollections).mockImplementation(async () => {
      expect(s().collections.map((c) => c.id)).toEqual(["c2", "c1"]);
    });
    await s().reorderCollections(["c2", "c1", "ghost"]);
    expect(api.reorderCollections).toHaveBeenCalledWith(["c2", "c1", "ghost"]);
    vi.mocked(api.reorderCollections).mockRejectedValue(new Error("x"));
    await s().reorderCollections(["c1", "c2"]);
    expect(toast.error).toHaveBeenCalledWith("Couldn't reorder collections", { description: "x" });
  });

  it("openRequest opens a tab once and focuses it after", async () => {
    await s().openRequest("r1");
    const opened = useTabsStore.getState().activeId;
    expect(activeTab()).toMatchObject({ parentId: "c1", workspaceId: "w1" });
    useTabsStore.getState().newTab();
    await s().openRequest("r1");
    expect(useTabsStore.getState().activeId).toBe(opened);
    expect(api.getRequest).toHaveBeenCalledTimes(1);

    vi.mocked(api.getRequest).mockRejectedValue(new Error("gone"));
    await s().openRequest("r2");
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the request", { description: "gone" });
  });

  it("newRequest saves a blank request, opens it and starts renaming", async () => {
    vi.mocked(api.saveAs).mockResolvedValue(req("r9", { name: "New request" }));
    mockTree([col("c1", ["r1", "r2", "r9"])]);
    await s().newRequest("c1");
    expect(api.saveAs).toHaveBeenCalledWith(
      "c1",
      "New request",
      expect.objectContaining({ name: "New request", auth: expect.objectContaining({ type: "inherit" }) }),
    );
    expect(activeTab().saved?.id).toBe("r9");
    expect(s().renameTarget).toBe("r9");

    vi.mocked(api.saveAs).mockRejectedValue(new Error("x"));
    await s().newRequest("c1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't create the request", { description: "x" });
  });

  it("renameRequest renames the open tab too; skips no-ops", async () => {
    await s().openRequest("r1");
    vi.mocked(api.renameRequest).mockResolvedValue(req("r1", { name: "Users" }));
    await s().renameRequest("r1", "Req r1");
    await s().renameRequest("nope", "x");
    expect(api.renameRequest).not.toHaveBeenCalled();
    await s().renameRequest("r1", "Users");
    expect(activeTab().request.name).toBe("Users");

    await s().renameRequest("r2", "Other");
    expect(api.renameRequest).toHaveBeenLastCalledWith("r2", "Other");

    vi.mocked(api.renameRequest).mockRejectedValue(new Error("x"));
    await s().renameRequest("r2", "Again");
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename the request", { description: "x" });
  });

  it("duplicateRequest starts renaming the copy", async () => {
    vi.mocked(api.duplicateRequest).mockResolvedValue(req("r1copy"));
    await s().duplicateRequest("r1");
    expect(s().renameTarget).toBe("r1copy");
    vi.mocked(api.duplicateRequest).mockRejectedValue(new Error("x"));
    await s().duplicateRequest("r1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't duplicate the request", { description: "x" });
  });

  it("deleteRequest closes its clean tab", async () => {
    await s().openRequest("r1");
    mockTree([col("c1", ["r2"])]);
    await s().deleteRequest("r1");
    expect(tabs().some((t) => t.saved?.id === "r1")).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Request deleted");
    vi.mocked(api.deleteRequest).mockRejectedValue(new Error("x"));
    await s().deleteRequest("r2");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the request", { description: "x" });
  });

  it("moveRequest reorders within, moves across, and skips no-ops", async () => {
    await s().moveRequest("r1", "c1", 0);
    await s().moveRequest("missing", "c1", 0);
    await s().moveRequest("r1", "missing", 0);
    expect(api.moveRequest).not.toHaveBeenCalled();

    vi.mocked(api.moveRequest).mockResolvedValue(req("r1"));
    await s().moveRequest("r1", "c1", 5);
    expect(api.moveRequest).toHaveBeenCalledWith("r1", "c1", 1);

    vi.mocked(api.moveRequest).mockImplementation(async () => {
      const c2 = s().collections.find((c) => c.id === "c2");
      expect(c2?.children.map((r) => [r.id, r.parentId])).toEqual([["r2", "c2"]]);
      return req("r2");
    });
    await s().moveRequest("r2", "c2", 0);
    expect(api.moveRequest).toHaveBeenLastCalledWith("r2", "c2", 0);

    vi.mocked(api.moveRequest).mockRejectedValue(new Error("x"));
    await s().moveRequest("r1", "c2", 0);
    expect(toast.error).toHaveBeenCalledWith("Couldn't move the request", { description: "x" });
  });
});

describe("workspace store: folders", () => {
  // c1[ r1, f1[ r2, f2[ r3 ] ] ]  c2[]
  const nested = () => [col("c1", ["r1"], [fold("f1", ["r2"], [fold("f2", ["r3"])])]), col("c2", [])];
  beforeEach(async () => {
    await openReady(nested());
  });

  const openTab = (id: string, parentId: string, edited = false): void => {
    const r = req(id);
    useTabsStore.setState((st) => ({
      tabs: [
        ...st.tabs,
        {
          id: `t-${id}`,
          request: edited ? { ...r, url: "https://edited" } : r,
          saved: r,
          parentId,
          workspaceId: "w1",
          sendId: null,
          result: null,
          doc: null,
        },
      ],
    }));
  };

  it("createFolder refreshes and starts renaming it", async () => {
    vi.mocked(api.createFolder).mockResolvedValue({ id: "f9", name: "New folder" });
    expect(await s().createFolder("f1")).toBe("f9");
    expect(api.createFolder).toHaveBeenCalledWith("f1", "New folder");
    expect(s().renameTarget).toBe("f9");

    vi.mocked(api.createFolder).mockRejectedValue(new Error("x"));
    expect(await s().createFolder("c1", "Y")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Couldn't create the folder", { description: "x" });
  });

  it("renameFolder skips blank or unchanged names and reports errors", async () => {
    await s().renameFolder("f1", " ");
    await s().renameFolder("f1", "Folder f1");
    await s().renameFolder("r1", "Not a folder");
    expect(api.renameFolder).not.toHaveBeenCalled();
    await s().renameFolder("f2", " Tokens ");
    expect(api.renameFolder).toHaveBeenCalledWith("f2", "Tokens");
    vi.mocked(api.renameFolder).mockRejectedValue(new Error("busy"));
    await s().renameFolder("f2", "Other");
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename the folder", { description: "busy" });
  });

  it("deleteFolder closes clean tabs inside it (at any depth) and detaches edited ones", async () => {
    openTab("r1", "c1");
    openTab("r2", "f1");
    openTab("r3", "f2", true);
    mockTree([col("c1", ["r1"]), col("c2", [])]);
    await s().deleteFolder("f1");
    expect(api.deleteFolder).toHaveBeenCalledWith("f1");
    expect(tabs().map((t) => [t.id, t.saved?.id ?? null])).toEqual([
      ["t1", null],
      ["t-r1", "r1"],
      ["t-r3", null],
    ]);
    expect(toast.success).toHaveBeenCalledWith("Folder deleted");

    vi.mocked(api.deleteFolder).mockRejectedValue(new Error("x"));
    await s().deleteFolder("f2");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the folder", { description: "x" });
  });

  it("deleteCollection also handles requests inside folders", async () => {
    openTab("r3", "f2");
    mockTree([col("c2", [])]);
    await s().deleteCollection("c1");
    expect(tabs().some((t) => t.saved?.id === "r3")).toBe(false);
  });

  it("moveFolder moves optimistically; tabs inside keep their folder, moved requests get the new parent", async () => {
    openTab("r3", "f2");
    openTab("r2", "f1");
    vi.mocked(api.moveFolder).mockImplementation(async () => {
      expect(
        s()
          .collections.find((c) => c.id === "c2")
          ?.children.map((c) => c.id),
      ).toEqual(["f2"]);
    });
    mockTree([col("c1", ["r1"], [fold("f1", ["r2"])]), col("c2", [], [fold("f2", ["r3"])])]);
    await s().moveFolder("f2", "c2", 0);
    expect(api.moveFolder).toHaveBeenCalledWith("f2", "c2", 0);
    expect(tabs().find((t) => t.id === "t-r3")?.parentId).toBe("f2");

    vi.mocked(api.moveRequest).mockResolvedValue(req("r2"));
    mockTree([col("c1", ["r1", "r2"], [fold("f1", [])]), col("c2", [], [fold("f2", ["r3"])])]);
    await s().moveRequest("r2", "c1", 1);
    expect(api.moveRequest).toHaveBeenCalledWith("r2", "c1", 1);
    expect(tabs().find((t) => t.id === "t-r2")?.parentId).toBe("c1");

    // No-op: already there.
    vi.mocked(api.moveFolder).mockClear();
    await s().moveFolder("f1", "c1", 5);
    expect(api.moveFolder).not.toHaveBeenCalled();

    vi.mocked(api.moveFolder).mockRejectedValue(new Error("a folder can't be moved into itself"));
    await s().moveFolder("f1", "c2", 0);
    expect(toast.error).toHaveBeenCalledWith("Couldn't move the folder", {
      description: "a folder can't be moved into itself",
    });
  });

  it("newRequest into a folder opens the tab with the folder as parent", async () => {
    vi.mocked(api.saveAs).mockResolvedValue(req("r9", { name: "New request" }));
    mockTree([col("c1", ["r1"], [fold("f1", ["r2", "r9"])])]);
    await s().newRequest("f1");
    expect(api.saveAs).toHaveBeenCalledWith("f1", "New request", expect.anything());
    expect(activeTab()).toMatchObject({ parentId: "f1" });
  });

  it("openRequest and renameRequest find nested requests", async () => {
    await s().openRequest("r3");
    expect(activeTab()).toMatchObject({ parentId: "f2" });
    vi.mocked(api.renameRequest).mockResolvedValue(req("r3", { name: "Deep" }));
    await s().renameRequest("r3", "Deep");
    expect(api.renameRequest).toHaveBeenCalledWith("r3", "Deep");
    expect(activeTab().request.name).toBe("Deep");
  });
});
