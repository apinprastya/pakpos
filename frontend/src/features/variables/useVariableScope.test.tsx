import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { makePreview, makePreviewVar, makeVar } from "@/test/fixtures";
import type { PreviewState } from "@/features/request/usePreview";
import { emptyDocDraft, type DocKind, type Tab } from "@/stores/tabs";
import { useEnvironmentsStore } from "@/stores/environments";
import { useWorkspaceStore } from "@/stores/workspace";
import { useVariableScope } from "./useVariableScope";

const requestTab: Tab = {
  id: "t1",
  request: emptyRequest(),
  saved: null,
  parentId: "c1",
  workspaceId: "w1",
  sendId: null,
  result: null,
  doc: null,
};

function docTab(
  kind: DocKind,
  targetId: string,
  name: string,
  variables = [makeVar("draft", "{{host}}")],
): Tab {
  const draft = { ...emptyDocDraft(), variables };
  return { ...requestTab, doc: { kind, targetId, name, draft, saved: draft, missing: false } };
}

const openWorkspace = () => useWorkspaceStore.setState({ workspace: { id: "w1", name: "WS", path: "/w1" } });

describe("useVariableScope for request tabs", () => {
  it("is ready with no variables when no workspace is open", () => {
    const { result } = renderHook(() =>
      useVariableScope(requestTab, { preview: null, loading: false, error: null }),
    );
    expect(result.current).toMatchObject({ hasWorkspace: false, ready: true });
    expect(api.visibleVariables).not.toHaveBeenCalled();
  });

  it("uses the tab's preview and keeps its identity while the content is the same", () => {
    openWorkspace();
    const state = (vars = [makePreviewVar("host", "h")]): PreviewState => ({
      preview: makePreview({ variables: vars, environment: { id: "e1", name: "Dev" } }),
      loading: false,
      error: null,
    });
    const { result, rerender } = renderHook((p: PreviewState) => useVariableScope(requestTab, p), {
      initialProps: { preview: null, loading: true, error: null } as PreviewState,
    });
    expect(result.current.ready).toBe(false);
    rerender(state());
    const first = result.current;
    expect(first.ready).toBe(true);
    expect(first.variables.get("host")?.value).toBe("h");
    expect(first.environment?.name).toBe("Dev");
    rerender(state());
    expect(result.current).toBe(first);
    rerender(state([makePreviewVar("host", "changed")]));
    expect(result.current).not.toBe(first);
    rerender({ preview: null, loading: false, error: "boom" });
    expect(result.current.ready).toBe(true);
    expect(api.visibleVariables).not.toHaveBeenCalled();
  });
});

describe("useVariableScope for settings tabs", () => {
  beforeEach(() => {
    openWorkspace();
    vi.mocked(api.visibleVariables).mockResolvedValue({
      variables: [makePreviewVar("host", "dev"), makePreviewVar("old", "x")],
      environment: { id: "e1", name: "Dev" },
    });
  });

  it.each([
    ["environment", "e1", ["", "e1"]],
    ["globals", "", ["", ""]],
    ["collection", "c1", ["c1", ""]],
    ["folder", "f1", ["f1", ""]],
  ] as const)("asks Go for what a %s tab sees", async (kind, id, args) => {
    const { result } = renderHook(() => useVariableScope(docTab(kind, id, "Name")));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.visibleVariables).toHaveBeenCalledWith(...args);
  });

  it("applies the unsaved rows of the edited environment", async () => {
    vi.mocked(api.visibleVariables).mockResolvedValue({
      variables: [
        makePreviewVar("saved", "gone from the draft"),
        makePreviewVar("g", "1", { scope: "global" }),
      ],
      environment: { id: "e1", name: "Dev" },
    });
    const { result } = renderHook(() => useVariableScope(docTab("environment", "e1", "Dev")));
    expect(result.current.ready).toBe(false);
    // The draft is visible right away, before Go answers.
    expect(result.current.variables.get("draft")?.value).toBe("{{host}}");
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect([...result.current.variables.keys()]).toEqual(["draft", "g"]);
  });

  it("doesn't apply rows to a folder (it has no variables)", async () => {
    const { result } = renderHook(() => useVariableScope(docTab("folder", "f1", "Admin")));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect([...result.current.variables.keys()]).toEqual(["host", "old"]);
  });

  it("refreshes when variables change, and settles without them when Go fails", async () => {
    const { result } = renderHook(() => useVariableScope(docTab("folder", "f1", "Admin")));
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(api.visibleVariables).mockRejectedValue(new Error("no"));
    act(() => useEnvironmentsStore.getState().touch());
    await waitFor(() => expect(result.current.variables.size).toBe(0));
    expect(result.current.ready).toBe(true);
    expect(api.visibleVariables).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a workspace", () => {
    useWorkspaceStore.setState({ workspace: null });
    const { result } = renderHook(() => useVariableScope(docTab("folder", "f1", "Admin")));
    expect(result.current.ready).toBe(true);
    expect(api.visibleVariables).not.toHaveBeenCalled();
  });
});
