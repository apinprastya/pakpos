import { lazy } from "react";
import { Wrench } from "lucide-react";
import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { TOOLS, type ToolDef } from "@/features/tools/registry";
import { activeTab, resetTabs } from "@/test/store";
import { isDirty, isRequestTab, restoreTool, tabTitle, useTabsStore } from "./tabs";
import { useWorkspaceStore } from "./workspace";

const s = () => useTabsStore.getState();
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";

/** A tool that persists its state, added to the registry for these tests. */
const notes: ToolDef = {
  id: "notes",
  label: "Notes",
  description: "Test tool.",
  icon: Wrench,
  keywords: [],
  persist: true,
  component: lazy(async () => ({ default: () => null })),
  initialState: (input) => ({ text: input ?? "" }),
  withInput: (_state, input) => ({ text: input }),
  restore: (raw) => ({ text: (raw as { text?: string } | null)?.text ?? "restored" }),
};

function stored() {
  return JSON.parse(localStorage.getItem("pakpos-tabs")!) as {
    state: { tabs: { tool: { id: string; state: unknown } | null }[] };
  };
}

describe("tabs store: tool tabs", () => {
  beforeAll(() => (TOOLS as ToolDef[]).push(notes));
  afterAll(() => (TOOLS as ToolDef[]).splice(TOOLS.indexOf(notes), 1));
  beforeEach(() => {
    localStorage.clear();
    resetTabs();
  });

  it("opens a tool tab, then focuses it instead of opening another", () => {
    const id = s().openTool("jwt");
    expect(s().tabs).toHaveLength(2);
    expect(activeTab().tool).toEqual({ id: "jwt", state: { token: "", revealed: {} } });
    expect(tabTitle(activeTab())).toBe("JWT decoder");
    expect(isDirty(activeTab())).toBe(false);
    expect(isRequestTab(activeTab())).toBe(false);
    expect(activeTab().workspaceId).toBe("");
    expect(activeTab().parentId).toBe("");

    s().activate("t1");
    expect(s().openTool("jwt")).toBe(id);
    expect(s().tabs).toHaveLength(2);
    expect(s().activeId).toBe(id);
  });

  it("passes input to a new tab and replaces the input of the open one", () => {
    const id = s().openTool("jwt", TOKEN);
    expect(activeTab().tool?.state).toEqual({ token: TOKEN, revealed: {} });
    s().updateToolState(id, (st) => ({ ...(st as object), revealed: { a: "x" } }));
    s().activate("t1");
    expect(s().openTool("jwt", "{{access_token}}")).toBe(id);
    expect(s().tabs).toHaveLength(2);
    expect(activeTab().tool?.state).toEqual({ token: "{{access_token}}", revealed: {} });
    // No input: the state stays as it is.
    s().openTool("jwt");
    expect(activeTab().tool?.state).toEqual({ token: "{{access_token}}", revealed: {} });
  });

  it("ignores unknown tools and state updates for other tabs", () => {
    expect(s().openTool("nope")).toBe("");
    expect(s().tabs).toHaveLength(1);
    const before = s().tabs[0];
    s().updateToolState("t1", () => "x");
    expect(s().tabs[0]).toBe(before);
  });

  it("closing the last tab leaves a request tab", () => {
    s().close("t1");
    const id = s().openTool("jwt");
    s().close(s().tabs[0].id);
    s().close(id);
    expect(s().tabs).toHaveLength(1);
    expect(isRequestTab(s().tabs[0])).toBe(true);
  });

  it("never writes a JWT tab's token to localStorage, and restores the tab empty", async () => {
    const id = s().openTool("jwt", TOKEN);
    s().updateToolState(id, (st) => ({ ...(st as object), revealed: { access_token: "s3cret" } }));
    const raw = localStorage.getItem("pakpos-tabs")!;
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("s3cret");
    expect(stored().state.tabs[1].tool).toEqual({ id: "jwt", state: null });

    resetTabs({}, { id: "other" });
    localStorage.setItem("pakpos-tabs", raw);
    await useTabsStore.persist.rehydrate();
    expect(s().tabs).toHaveLength(2);
    expect(s().tabs[1].tool).toEqual({ id: "jwt", state: { token: "", revealed: {} } });
    expect(s().tabs[1].doc).toBeNull();
    expect(s().activeId).toBe(s().tabs[1].id);
  });

  it("persists the state of tools that ask for it", async () => {
    s().openTool("notes", "keep me");
    const raw = localStorage.getItem("pakpos-tabs")!;
    expect(stored().state.tabs[1].tool).toEqual({ id: "notes", state: { text: "keep me" } });
    resetTabs({}, { id: "other" });
    localStorage.setItem("pakpos-tabs", raw);
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[1].tool).toEqual({ id: "notes", state: { text: "keep me" } });
  });

  it("keeps the JSON tool's state across restarts, but not a large input", async () => {
    const id = s().openTool("json", '{"a":1}');
    s().updateToolState(id, (st) => ({ ...(st as object), sortKeys: true }));
    let raw = localStorage.getItem("pakpos-tabs")!;
    resetTabs({}, { id: "other" });
    localStorage.setItem("pakpos-tabs", raw);
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[1].tool).toEqual({
      id: "json",
      state: { input: '{"a":1}', mode: "format", indent: "2", sortKeys: true },
    });

    s().updateToolState(s().tabs[1].id, (st) => ({ ...(st as object), input: "x".repeat(200_000) }));
    raw = localStorage.getItem("pakpos-tabs")!;
    expect(raw.length).toBeLessThan(10_000);
    expect(stored().state.tabs[1].tool?.state).toMatchObject({ input: "", sortKeys: true });
  });

  it("keeps the URL tool's mode and direction, but not a large input", async () => {
    const id = s().openTool("url", "a b");
    s().updateToolState(id, (st) => ({ ...(st as object), mode: "form", direction: "decode" }));
    expect(stored().state.tabs[1].tool?.state).toEqual({ input: "a b", mode: "form", direction: "decode" });
    s().updateToolState(id, (st) => ({ ...(st as object), input: "x".repeat(200_000) }));
    expect(stored().state.tabs[1].tool?.state).toEqual({ input: "", mode: "form", direction: "decode" });
  });

  it("never writes the hash tool's text or key to localStorage", async () => {
    const id = s().openTool("hash", "my text");
    s().updateToolState(id, (st) => ({
      ...(st as object),
      hmac: true,
      key: "hmac-key",
      revealed: { k: "rv" },
    }));
    const raw = localStorage.getItem("pakpos-tabs")!;
    for (const secret of ["my text", "hmac-key", '"rv"']) expect(raw).not.toContain(secret);
    resetTabs({}, { id: "other" });
    localStorage.setItem("pakpos-tabs", raw);
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[1].tool?.state).toMatchObject({ text: "", key: "", hmac: false, revealed: {} });
  });

  it("restores unknown tools by id and drops malformed entries", async () => {
    const tabs = [
      {
        id: "a",
        request: emptyRequest(),
        saved: null,
        workspaceId: "",
        tool: { id: "gone", state: { x: 1 } },
      },
      { id: "b", request: emptyRequest(), saved: null, workspaceId: "", tool: { id: 3 } },
      { id: "c", request: emptyRequest(), saved: null, workspaceId: "", tool: "jwt" },
      { id: "d", request: emptyRequest(), saved: null, workspaceId: "", tool: { id: "jwt", state: "bad" } },
    ];
    localStorage.setItem("pakpos-tabs", JSON.stringify({ state: { tabs, activeId: "a" }, version: 1 }));
    await useTabsStore.persist.rehydrate();
    expect(s().tabs.map((t) => t.tool)).toEqual([
      { id: "gone", state: null },
      null,
      null,
      { id: "jwt", state: { token: "", revealed: {} } },
    ]);
    expect(tabTitle(s().tabs[0])).toBe("Unknown tool");
    expect(restoreTool(null)).toBeNull();
    expect(restoreTool({ id: "" })).toBeNull();
    expect(restoreTool({ id: "notes", state: null })).toEqual({ id: "notes", state: { text: "restored" } });
  });

  it("tool tabs survive a workspace switch and tree syncs", async () => {
    const id = s().openTool("jwt", TOKEN);
    vi.mocked(api.tree).mockResolvedValue({ collections: [], problems: [] });
    vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w2", name: "Other", path: "/w2" });
    await useWorkspaceStore.getState().init();
    await useWorkspaceStore.getState().refresh({ fromDisk: true });
    expect(s().tabs.find((t) => t.id === id)?.tool?.state).toEqual({ token: TOKEN, revealed: {} });
    expect(api.getRequest).not.toHaveBeenCalled();

    vi.mocked(api.currentWorkspace).mockResolvedValue(null);
    vi.mocked(api.recentWorkspaces).mockResolvedValue([]);
    await useWorkspaceStore.getState().init();
    expect(s().tabs.some((t) => t.id === id)).toBe(true);
  });
});
