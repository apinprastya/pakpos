import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { emptyAuth, emptyRequest, emptyScripts, type Scripts } from "@/lib/model";
import { RequestPane } from "@/features/request/RequestPane";
import { DocEditor } from "@/features/scopes/DocEditor";
import { saveDocTab } from "@/features/scopes/docActions";
import { isDirty, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { col, folder, req } from "@/test/fixtures";
import { editorText, editorView, setEditorText } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { levelsAbove } from "./useInheritedScripts";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tabs = () => useTabsStore.getState();
const scripts = (patch: Partial<Scripts> = {}): Scripts => ({ ...emptyScripts(), ...patch });

function Active() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)!);
  return tab.doc ? <DocEditor key={tab.id} tab={tab} /> : <RequestPane />;
}

function renderActive() {
  return render(
    <TooltipProvider>
      <Active />
    </TooltipProvider>,
  );
}

function collectionSettings(s: Scripts = scripts()) {
  return {
    id: "c1",
    name: "Users",
    auth: { ...emptyAuth(), type: "none" as const },
    headers: [],
    variables: [],
    scripts: s,
  };
}
function folderSettings(s: Scripts = scripts()) {
  return {
    id: "f1",
    name: "Admin",
    auth: { ...emptyAuth(), type: "inherit" as const },
    headers: [],
    scripts: s,
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    treeLoaded: true,
    collections: [col("c1", "Users", [folder("f1", "Admin", [req("r1")])])],
  });
  vi.mocked(api.getCollection).mockResolvedValue(collectionSettings());
  vi.mocked(api.getFolder).mockResolvedValue(folderSettings());
});

describe("request Scripts tab", () => {
  it("edits the pre-request and test scripts of the tab's request", async () => {
    const user = userEvent.setup();
    const saved = { ...emptyRequest(), id: "r1", name: "Get user", url: "https://x" };
    resetTabs(saved, { saved, parentId: "f1", workspaceId: "w1" });
    renderActive();
    const tab = screen.getByRole("tab", { name: /^Scripts/ });
    expect(within(tab).queryByLabelText("has scripts")).not.toBeInTheDocument();
    await user.click(tab);
    await screen.findByRole("textbox", { name: "Pre-request script" });
    expect(screen.getByText(/Runs before this request is sent/)).toBeInTheDocument();
    expect(screen.getByText(/The collection's and folders' scripts run first/)).toBeInTheDocument();

    setEditorText("Pre-request script", 'pm.environment.set("a", 1);');
    expect(activeTab().request.scripts.preRequest).toBe('pm.environment.set("a", 1);');
    expect(isDirty(activeTab())).toBe(true);
    expect(within(tab).getByLabelText("has scripts")).toBeInTheDocument();
    expect(screen.queryByText(/Runs before this request is sent/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await screen.findByRole("textbox", { name: "Test script" });
    expect(activeTab().sections.scripts).toBe("test");
    expect(screen.getByText(/Runs after the response of this request arrives/)).toBeInTheDocument();
    setEditorText("Test script", "pm.test('ok', () => {});");
    expect(activeTab().request.scripts).toEqual({
      preRequest: 'pm.environment.set("a", 1);',
      test: "pm.test('ok', () => {});",
    });
  });

  it("inserts snippets at the cursor and disables those for the other script", async () => {
    const user = userEvent.setup();
    resetTabs(
      { url: "https://x", scripts: scripts({ preRequest: "// start" }) },
      { sections: { request: "scripts" } },
    );
    renderActive();
    await screen.findByRole("textbox", { name: "Pre-request script" });
    const view = editorView("Pre-request script");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    await user.click(screen.getByRole("button", { name: "Snippets" }));
    const disabled = await screen.findByRole("menuitem", { name: /Status code is 200/ });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveTextContent("Tests only: needs the response");
    await user.click(screen.getByRole("menuitem", { name: "Set a request header" }));
    expect(editorText("Pre-request script")).toBe(
      '// start\npm.request.headers.upsert({ key: "X-Request-Id", value: String(Date.now()) });\n',
    );
    expect(activeTab().request.scripts.preRequest).toContain("upsert");

    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await screen.findByRole("textbox", { name: "Test script" });
    await user.click(screen.getByRole("button", { name: "Snippets" }));
    expect(await screen.findByRole("menuitem", { name: /Set a request header/ })).toHaveTextContent(
      "Pre-request only",
    );
    await user.click(screen.getByRole("menuitem", { name: "Status code is 200" }));
    expect(activeTab().request.scripts.test).toContain("pm.response.to.have.status(200)");
  });

  it("shows the inherited scripts read-only and opens their settings", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCollection).mockResolvedValue(
      collectionSettings(scripts({ preRequest: "// collection" })),
    );
    vi.mocked(api.getFolder).mockResolvedValue(
      folderSettings(scripts({ preRequest: "// folder", test: "// t" })),
    );
    const saved = { ...emptyRequest(), id: "r1", name: "Get user", url: "https://x" };
    resetTabs(saved, { saved, parentId: "f1", workspaceId: "w1", sections: { request: "scripts" } });
    renderActive();
    const line = await screen.findByRole("button", {
      name: "Runs before this request's script: Collection Users, Folder Admin",
    });
    expect(line).toHaveAttribute("aria-expanded", "false");
    await user.click(line);
    expect(editorText("Collection Users pre-request script")).toBe("// collection");
    expect(editorView("Folder Admin pre-request script").state.readOnly).toBe(true);

    // The Tests script only lists levels with a test script.
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    expect(
      await screen.findByRole("button", { name: "Runs before this request's script: Folder Admin" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Pre-request" }));
    await user.click(await screen.findByRole("button", { name: /Runs before/ }));
    await user.click(screen.getByRole("button", { name: "Open collection settings" }));
    await waitFor(() => expect(activeTab().doc).toMatchObject({ kind: "collection", targetId: "c1" }));
    expect(activeTab().sections).toMatchObject({ settings: "scripts", scripts: "prerequest" });
  });
});

describe("collection and folder Scripts tabs", () => {
  it("edits a collection's scripts and saves them only when changed", async () => {
    const user = userEvent.setup();
    resetTabs();
    tabs().openDoc("collection", "c1", "Users", "w1");
    renderActive();
    await user.click(await screen.findByRole("tab", { name: /^Scripts/ }));
    await screen.findByRole("textbox", { name: "Pre-request script" });
    expect(screen.getByText(/Runs before every request in this collection is sent/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Runs before/ })).not.toBeInTheDocument();
    setEditorText("Pre-request script", "console.log(1)");
    expect(screen.getByRole("tab", { name: /^Scripts/ })).toContainElement(
      screen.getByLabelText("has scripts"),
    );
    vi.mocked(api.saveCollection).mockResolvedValue(
      collectionSettings(scripts({ preRequest: "console.log(1)" })),
    );
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect(api.saveCollection).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({ scripts: { preRequest: "console.log(1)", test: "" } }),
      [],
    );

    // A save without script edits leaves them to Go.
    tabs().updateDoc(activeTab().id, (d) => ({ ...d, headers: [{ key: "X", value: "1", enabled: true }] }));
    await saveDocTab(activeTab().id);
    expect(vi.mocked(api.saveCollection).mock.lastCall![1].scripts).toBeUndefined();
  });

  it("shows a folder's inherited collection script and saves the folder's scripts", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCollection).mockResolvedValue(collectionSettings(scripts({ test: "// c" })));
    resetTabs();
    tabs().openDoc("folder", "f1", "Admin", "w1");
    tabs().setSection(activeTab().id, "settings", "scripts");
    tabs().setSection(activeTab().id, "scripts", "test");
    renderActive();
    await screen.findByRole("textbox", { name: "Test script" });
    expect(
      screen.getByText(/Runs after the response of every request in this folder arrives/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Runs before this folder's script: Collection Users" }),
    ).toBeInTheDocument();
    setEditorText("Test script", "pm.test('x', () => {})");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect(api.saveFolder).toHaveBeenLastCalledWith("f1", {
      auth: expect.anything(),
      headers: [],
      scripts: { preRequest: "", test: "pm.test('x', () => {})" },
    });
  });
});

describe("levelsAbove", () => {
  const tree = [col("c1", "Users", [folder("f1", "Admin", [folder("f2", "Deep")])])];
  it("lists the chain outermost first", () => {
    expect(levelsAbove(tree, { kind: "request", id: "r", parentId: "f2" }).map((l) => l.name)).toEqual([
      "Users",
      "Admin",
      "Deep",
    ]);
    expect(levelsAbove(tree, { kind: "request", id: "r", parentId: "" })).toEqual([]);
    expect(levelsAbove(tree, { kind: "request", id: "r", parentId: "gone" })).toEqual([]);
    expect(levelsAbove(tree, { kind: "folder", id: "f2" }).map((l) => l.id)).toEqual(["c1", "f1"]);
    expect(levelsAbove(tree, { kind: "collection", id: "c1" })).toEqual([]);
  });

  it("leaves out levels that fail to load", async () => {
    vi.mocked(api.getFolder).mockRejectedValue(new Error("gone"));
    vi.mocked(api.getCollection).mockResolvedValue(collectionSettings(scripts({ preRequest: "// c" })));
    const saved = { ...emptyRequest(), id: "r1", name: "Get user", url: "https://x" };
    resetTabs(saved, { saved, parentId: "f1", workspaceId: "w1", sections: { request: "scripts" } });
    renderActive();
    expect(
      await screen.findByRole("button", { name: "Runs before this request's script: Collection Users" }),
    ).toBeInTheDocument();
  });
});
