import { act, render, screen, within } from "@testing-library/react";
import App from "@/App";
import { api, type WorkspaceChange } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { col, makeResult } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { sendTab } from "@/features/request/actions";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";

describe("workspace sync in the app", () => {
  beforeEach(() => {
    resetTabs();
    useLayoutStore.setState({ sidebarView: "collections", splitOrientation: "vertical" });
  });

  it("restores the workspace on start, shows it in the status bar, and follows external changes", async () => {
    let emit: (c: WorkspaceChange) => void = () => {};
    const unsubscribe = vi.fn();
    vi.mocked(api.onWorkspaceChanged).mockImplementation((cb) => {
      emit = cb;
      return unsubscribe;
    });
    vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w1", name: "Shop API", path: "/work/shop" });
    vi.mocked(api.tree).mockResolvedValue({
      collections: [col("c1", "Users")],
      problems: [],
    });
    const { unmount } = render(<App />);
    expect(await screen.findByRole("treeitem", { name: "Users" })).toBeInTheDocument();
    expect(within(screen.getByRole("contentinfo")).getByText("Shop API")).toBeInTheDocument();

    vi.mocked(api.tree).mockResolvedValue({
      collections: [col("c2", "Orders")],
      problems: [],
    });
    await act(async () => emit({ workspaceId: "w1", problems: [] }));
    expect(await screen.findByRole("treeitem", { name: "Orders" })).toBeInTheDocument();

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("refreshes history after a recorded send", async () => {
    resetTabs({ ...emptyRequest(), url: "https://x" });
    useHistoryStore.setState({ loaded: true });
    vi.mocked(api.send).mockResolvedValue(makeResult({ response: null, error: null, historyId: 3 }));
    await sendTab("t1");
    expect(api.historyList).toHaveBeenCalled();
  });
});
