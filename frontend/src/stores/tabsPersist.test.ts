import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { makeWebhook } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { flushTabs, hydrateTabs, TABS_STATE_KEY, TABS_STORAGE_KEY, useTabsStore } from "./tabs";
import { useUiStateStore } from "./uiState";

const s = () => useTabsStore.getState();

afterEach(() => {
  vi.useRealTimers();
});

describe("open tabs in Go", () => {
  it("saves the open tabs to Go shortly after a change, and right away on flush", () => {
    vi.useFakeTimers();
    resetTabs();
    vi.mocked(api.setUiState).mockClear();
    s().openDraft({ ...emptyRequest(), name: "Orders" });
    s().openWebhook("h1", "Payments", "w1");
    expect(api.setUiState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(api.setUiState).toHaveBeenCalledTimes(1);
    const [key, value] = vi.mocked(api.setUiState).mock.calls[0];
    expect(key).toBe(TABS_STATE_KEY);
    const saved = JSON.parse(value as string);
    expect(saved.state.tabs.map((t: { request: { name: string } }) => t.request.name)).toEqual([
      "",
      "Orders",
      "",
    ]);
    expect(saved.state.tabs[2].doc.kind).toBe("webhook");

    s().openDraft({ ...emptyRequest(), name: "Later" });
    flushTabs();
    expect(api.setUiState).toHaveBeenCalledTimes(2);
    flushTabs(); // nothing waiting
    expect(api.setUiState).toHaveBeenCalledTimes(2);
  });

  it("logs a failed save instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.setUiState).mockRejectedValueOnce(new Error("db locked"));
    s().openDraft(emptyRequest());
    flushTabs();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("save open tabs", expect.any(Error)));
    warn.mockRestore();
  });

  it("restores Go's copy at startup over whatever localStorage holds", async () => {
    // What a previous run left in Go: a request and a webhook tab.
    resetTabs({ name: "Orders" }, { id: "a" });
    const webhookTab = s().openWebhook("h1", "Payments", "w1");
    s().markWebhookSaved(webhookTab, makeWebhook());
    const previous = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY)!);

    // A new start: WebKit lost localStorage, Go still has the tabs.
    localStorage.clear();
    resetTabs({}, { id: "fresh" });
    localStorage.clear();
    useUiStateStore.setState({ values: { [TABS_STATE_KEY]: previous }, loaded: true });
    await hydrateTabs();
    expect(s().tabs.map((t) => t.doc?.kind ?? t.request.name)).toEqual(["Orders", "webhook"]);
    expect(s().tabs[1].doc!.webhook!.saved!.name).toBe("Payments");
    expect(s().activeId).toBe(webhookTab);
  });

  it("falls back to localStorage when Go has nothing", async () => {
    resetTabs({ name: "Local" }, { id: "l" });
    const stored = localStorage.getItem(TABS_STORAGE_KEY)!;
    resetTabs({}, { id: "fresh" });
    localStorage.setItem(TABS_STORAGE_KEY, stored);
    useUiStateStore.setState({ values: {}, loaded: true });
    await hydrateTabs();
    expect(s().tabs[0].request.name).toBe("Local");
  });
});
