import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/shell/Sidebar";
import { api } from "@/lib/api";
import { emptyRequest, type HistorySummary } from "@/lib/model";
import { activeTab, resetTabs } from "@/test/store";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => {
  const x = new Date(now);
  x.setDate(x.getDate() - d);
  x.setHours(9, 30);
  return x.toISOString();
};
const entry = (id: number, extra: Partial<HistorySummary> = {}): HistorySummary => ({
  id,
  createdAt: minutesAgo(5),
  workspaceId: "",
  requestId: "",
  requestName: "",
  method: "GET",
  url: `https://api.example.com/items/${id}`,
  status: 200,
  durationMs: 12,
  size: 10,
  errorKind: "",
  errorMessage: "",
  ...extra,
});

function renderHistory() {
  useLayoutStore.setState({ sidebarView: "history" });
  return render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>,
  );
}

beforeEach(() => resetTabs());

describe("history view", () => {
  it("groups entries by day with status and time", async () => {
    vi.mocked(api.historyList).mockResolvedValue({
      items: [
        entry(3),
        entry(2, { method: "DELETE", status: 0, errorKind: "dns", createdAt: daysAgo(1) }),
        entry(1, { status: 0, errorKind: "canceled", createdAt: daysAgo(1) }),
      ],
      total: 3,
    });
    renderHistory();
    const today = await screen.findByRole("region", { name: "Today" });
    expect(within(today).getByRole("button", { name: /GET .*items\/3, 200, 5m ago/ })).toBeInTheDocument();
    const yesterday = screen.getByRole("region", { name: "Yesterday" });
    expect(within(yesterday).getByText("Failed")).toBeInTheDocument();
    expect(within(yesterday).getByText("Canceled")).toBeInTheDocument();
  });

  it("shows the empty state, and a no-match state when searching", async () => {
    const user = userEvent.setup();
    renderHistory();
    expect(await screen.findByText("No requests sent yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled();

    await user.type(screen.getByRole("searchbox", { name: "Search history" }), "orders");
    await waitFor(() =>
      expect(api.historyList).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "orders", offset: 0 }),
      ),
    );
    expect(await screen.findByText('No history matches "orders"')).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear search" })[1]);
    expect(screen.getByRole("searchbox", { name: "Search history" })).toHaveValue("");
    await user.type(screen.getByRole("searchbox", { name: "Search history" }), "a");
    await user.click(screen.getAllByRole("button", { name: "Clear search" })[0]);
    await user.type(screen.getByRole("searchbox", { name: "Search history" }), "b{Escape}");
    expect(screen.getByRole("searchbox", { name: "Search history" })).toHaveValue("");
  });

  it("opens, deletes and loads more", async () => {
    const user = userEvent.setup();
    vi.mocked(api.historyList)
      .mockResolvedValueOnce({ items: [entry(5), entry(4)], total: 3 })
      .mockResolvedValueOnce({ items: [entry(3)], total: 3 });
    vi.mocked(api.historyGet).mockResolvedValue({
      ...entry(5),
      request: { ...emptyRequest(), url: "https://api.example.com/items/5" },
      response: null,
    });
    renderHistory();
    await user.click(await screen.findByRole("button", { name: /items\/5,/ }));
    await waitFor(() => expect(activeTab().request.url).toBe("https://api.example.com/items/5"));

    await user.click(screen.getByRole("button", { name: "Load more (1 left)" }));
    expect(await screen.findByRole("button", { name: /items\/3,/ })).toBeInTheDocument();

    const row = screen.getByRole("button", { name: /items\/4,/ }).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Delete from history" }));
    expect(api.historyDelete).toHaveBeenCalledWith(4);
    await waitFor(() => expect(screen.queryByRole("button", { name: /items\/4,/ })).not.toBeInTheDocument());
  });

  it("clears all history after confirming", async () => {
    const user = userEvent.setup();
    vi.mocked(api.historyList).mockResolvedValue({ items: [entry(1), entry(2)], total: 2 });
    renderHistory();
    await screen.findByRole("region", { name: "Today" });
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/This deletes 2 entries from every workspace/)).toBeInTheDocument();
    vi.mocked(api.historyList).mockResolvedValue({ items: [], total: 0 });
    await user.click(within(dialog).getByRole("button", { name: "Clear history" }));
    expect(api.historyClear).toHaveBeenCalled();
    expect(await screen.findByText("No requests sent yet")).toBeInTheDocument();
  });

  it("reloads after a send once shown", async () => {
    vi.mocked(api.historyList).mockResolvedValue({ items: [], total: 0 });
    renderHistory();
    await screen.findByText("No requests sent yet");
    vi.mocked(api.historyList).mockResolvedValue({ items: [entry(7)], total: 1 });
    await act(() => useHistoryStore.getState().refresh());
    expect(await screen.findByRole("button", { name: /items\/7,/ })).toBeInTheDocument();
  });
});
