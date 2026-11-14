import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/shell/Sidebar";
import { ActivityRail } from "@/features/shell/ActivityRail";
import { RequestActions } from "@/features/request/RequestActions";
import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore } from "@/stores/palette";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { col, folder, makeHistorySummary, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tree = () => [
  col("c1", "Users", [
    folder("f1", "Admin", [folder("f2", "Deep", [req("r9", "Nested call")])]),
    req("r1", "Top"),
  ]),
  col("c2", "Orders", [req("r3", "Refund")]),
];

function renderSidebar(extra?: React.ReactNode) {
  return render(
    <TooltipProvider>
      <Sidebar />
      {extra}
    </TooltipProvider>,
  );
}

const treeItem = (name: string | RegExp) =>
  within(screen.getByRole("tree", { name: "Collections" })).getByRole("treeitem", { name });

beforeEach(() => {
  resetTabs();
  useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: tree(), treeLoaded: true });
  vi.mocked(api.tree).mockResolvedValue({ collections: tree(), problems: [] });
  useLayoutStore.setState({ sidebarView: "collections" });
});

describe("reveal in tree", () => {
  it("expands collapsed folders, scrolls to the row and focuses it", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    renderSidebar();
    expect(screen.queryByRole("treeitem", { name: /Nested call/ })).not.toBeInTheDocument();
    act(() => void useTreeStore.getState().revealInTree("r9"));
    const row = await waitFor(() => treeItem("GET Nested call"));
    await waitFor(() => expect(row).toHaveFocus());
    expect(scroll).toHaveBeenCalled();
    expect(treeItem("Admin")).toHaveAttribute("aria-expanded", "true");
    expect(useTreeStore.getState().reveal).toBeNull();
    scroll.mockRestore();
  });

  it("clears the filter so the revealed row can be shown", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole("searchbox", { name: "Filter requests" }), "refund");
    expect(screen.queryByRole("treeitem", { name: /Top/ })).not.toBeInTheDocument();
    act(() => void useTreeStore.getState().revealInTree("r1"));
    expect(screen.getByRole("searchbox", { name: "Filter requests" })).toHaveValue("");
    await waitFor(() => expect(treeItem("GET Top")).toHaveFocus());
  });

  it("only expands when another sidebar view is showing (opening from history)", async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({ sidebarView: "history" });
    useHistoryStore.setState({
      items: [makeHistorySummary(5, { requestId: "r9", url: "https://api/nested" })],
      total: 1,
      loaded: true,
    });
    vi.mocked(api.historyList).mockResolvedValue({
      items: [makeHistorySummary(5, { requestId: "r9", url: "https://api/nested" })],
      total: 1,
    });
    vi.mocked(api.historyGet).mockResolvedValue({
      ...makeHistorySummary(5, { requestId: "r9" }),
      request: { ...emptyRequest(), id: "r9", name: "Nested call" },
      response: null,
    });
    renderSidebar();
    await user.click(await screen.findByRole("button", { name: /GET https:\/\/api\/nested/ }));
    await waitFor(() => expect(activeTab().request.name).toBe("Nested call"));
    expect(useTreeStore.getState().states.w1.expanded).toEqual(new Set(["f:f1", "f:f2"]));
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "r:r9", focus: false });

    // Switching to the tree shows the expanded path.
    act(() => useLayoutStore.getState().setSidebarView("collections"));
    expect(treeItem("GET Nested call")).toBeInTheDocument();
  });

  it("is offered as Reveal in sidebar in the request's menu", async () => {
    const user = userEvent.setup();
    const saved = { ...emptyRequest(), id: "r9", name: "Nested call", url: "https://x" };
    const tab = resetTabs(saved, { saved, parentId: "f2", workspaceId: "w1" });
    useLayoutStore.setState({ sidebarView: "environments" });
    renderSidebar(<RequestActions tab={tab} />);
    await user.click(screen.getByRole("button", { name: "More request actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reveal in sidebar" }));
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
    await waitFor(() => expect(treeItem("GET Nested call")).toHaveFocus());
  });

  it("disables Reveal in sidebar for an unsaved request", async () => {
    const user = userEvent.setup();
    const tab = resetTabs({ url: "https://x" });
    renderSidebar(<RequestActions tab={tab} />);
    await user.click(screen.getByRole("button", { name: "More request actions" }));
    expect(await screen.findByRole("menuitem", { name: "Reveal in sidebar" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("palette button", () => {
  it("opens the command palette from the activity rail", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ActivityRail />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Command palette" }));
    expect(usePaletteStore.getState().open).toBe(true);
  });
});
