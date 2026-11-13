import { toast } from "sonner";
import { api } from "@/lib/api";
import { emptyRequest, type HistorySummary } from "@/lib/model";
import { activeTab, resetTabs } from "@/test/store";
import { HISTORY_PAGE_SIZE, useHistoryStore } from "./history";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) };
});

const s = () => useHistoryStore.getState();
const item = (id: number): HistorySummary => ({
  id,
  createdAt: "2026-11-14T10:00:00Z",
  workspaceId: "",
  requestId: "",
  requestName: "",
  method: "GET",
  url: `https://x/${id}`,
  status: 200,
  durationMs: 1,
  size: 1,
  errorKind: "",
  errorMessage: "",
});

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("history store", () => {
  it("loads the first page with the query", async () => {
    vi.mocked(api.historyList).mockResolvedValue({ items: [item(2), item(1)], total: 2 });
    await s().load("users");
    expect(api.historyList).toHaveBeenCalledWith({
      text: "users",
      workspaceId: "",
      offset: 0,
      limit: HISTORY_PAGE_SIZE,
    });
    expect(s()).toMatchObject({ total: 2, loaded: true, loading: false, query: "users" });
  });

  it("drops stale responses when a newer search started", async () => {
    let resolveFirst: (v: { items: HistorySummary[]; total: number }) => void = () => {};
    vi.mocked(api.historyList)
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ items: [item(9)], total: 1 });
    const first = s().load("a");
    await s().load("ab");
    resolveFirst({ items: [item(1)], total: 1 });
    await first;
    expect(s().items.map((i) => i.id)).toEqual([9]);
  });

  it("loadMore appends without duplicates and stops at the total", async () => {
    vi.mocked(api.historyList).mockResolvedValueOnce({ items: [item(3), item(2)], total: 3 });
    await s().load("");
    vi.mocked(api.historyList).mockResolvedValueOnce({ items: [item(2), item(1)], total: 3 });
    await s().loadMore();
    expect(api.historyList).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 2 }));
    expect(s().items.map((i) => i.id)).toEqual([3, 2, 1]);
    vi.mocked(api.historyList).mockClear();
    await s().loadMore();
    expect(api.historyList).not.toHaveBeenCalled();
  });

  it("reports load errors", async () => {
    vi.mocked(api.historyList).mockRejectedValueOnce(new Error("db"));
    await s().load();
    expect(toast.error).toHaveBeenCalledWith("Couldn't load history", { description: "db" });
    useHistoryStore.setState({ items: [item(1)], total: 5 });
    vi.mocked(api.historyList).mockRejectedValueOnce(new Error("db"));
    await s().loadMore();
    expect(toast.error).toHaveBeenCalledWith("Couldn't load more history", { description: "db" });
  });

  it("refresh only reloads once the list has been shown", async () => {
    await s().refresh();
    expect(api.historyList).not.toHaveBeenCalled();
    useHistoryStore.setState({ loaded: true });
    await s().refresh();
    expect(api.historyList).toHaveBeenCalledTimes(1);
  });

  it("opens an entry in a new tab with its stored response", async () => {
    resetTabs();
    vi.mocked(api.historyGet).mockResolvedValue({
      ...item(4),
      request: { ...emptyRequest(), id: "r", url: "https://x/4", method: "PUT" },
      response: null,
      errorKind: "timeout",
      errorMessage: "too slow",
      status: 0,
    });
    await s().open(4);
    expect(activeTab().request).toMatchObject({ url: "https://x/4", method: "PUT", id: "" });
    expect(activeTab().result).toEqual({
      response: null,
      error: { kind: "timeout", message: "too slow" },
      historyId: 4,
    });
    vi.mocked(api.historyGet).mockRejectedValue(new Error("gone"));
    await s().open(5);
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the history entry", { description: "gone" });
  });

  it("removes entries and clears history", async () => {
    useHistoryStore.setState({ items: [item(1), item(2)], total: 2 });
    await s().remove(1);
    expect(s()).toMatchObject({ total: 1 });
    expect(s().items.map((i) => i.id)).toEqual([2]);
    await s().clear();
    expect(s()).toMatchObject({ items: [], total: 0 });
    expect(toast.success).toHaveBeenCalledWith("History cleared");

    vi.mocked(api.historyDelete).mockRejectedValue(new Error("x"));
    vi.mocked(api.historyClear).mockRejectedValue(new Error("y"));
    await s().remove(2);
    await s().clear();
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the history entry", { description: "x" });
    expect(toast.error).toHaveBeenCalledWith("Couldn't clear history", { description: "y" });
  });
});
