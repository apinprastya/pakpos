import { toast } from "sonner";
import { api } from "@/lib/api";
import { makeWebhook, makeWebhookRequest, makeWebhookStatus } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { isDirty, tabTitle, useTabsStore } from "./tabs";
import { LOG_CAP, LOG_PAGE, useWebhooksStore } from "./webhooks";
import { useWorkspaceStore } from "./workspace";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const store = () => useWebhooksStore.getState();
const tabs = () => useTabsStore.getState();
const hook = makeWebhook("h1", "Payments");
const other = makeWebhook("h2", "GitHub");

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  vi.mocked(api.listWebhooks).mockResolvedValue([hook, other]);
});

describe("webhooks store: list", () => {
  it("loads the open workspace's webhooks, clears without one, reports errors", async () => {
    await store().load();
    expect(store()).toMatchObject({ status: "ready", workspaceId: "w1", error: null });
    expect(store().webhooks.map((w) => w.name)).toEqual(["Payments", "GitHub"]);

    useWorkspaceStore.setState({ workspace: null });
    await store().load();
    expect(store()).toMatchObject({ status: "idle", workspaceId: null, webhooks: [] });

    useWorkspaceStore.setState({ workspace: ws });
    vi.mocked(api.listWebhooks).mockRejectedValue(new Error("boom"));
    await store().load();
    expect(store()).toMatchObject({ status: "error", error: "boom" });
  });

  it("ignores a load that finished after a newer one", async () => {
    let resolveFirst: (v: (typeof hook)[]) => void = () => {};
    vi.mocked(api.listWebhooks).mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    const first = store().load();
    await store().load();
    resolveFirst([makeWebhook("old")]);
    await first;
    expect(store().webhooks.map((w) => w.id)).toEqual(["h1", "h2"]);
  });

  it("creates (opening it in rename mode), renames, duplicates and deletes", async () => {
    const created = makeWebhook("h3", "New webhook");
    vi.mocked(api.createWebhook).mockResolvedValue(created);
    expect(await store().create()).toEqual(created);
    expect(api.createWebhook).toHaveBeenCalledWith("New webhook");
    expect(store().renameTarget).toBe("h3");
    const active = tabs().tabs.find((t) => t.id === tabs().activeId)!;
    expect(active.doc).toMatchObject({ kind: "webhook", targetId: "h3" });
    expect(active.workspaceId).toBe("w1");
    store().setRenameTarget(null);

    vi.mocked(api.renameWebhook).mockResolvedValue(makeWebhook("h1", "Stripe"));
    await store().rename("h1", "Stripe");
    expect(api.renameWebhook).toHaveBeenCalledWith("h1", "Stripe");

    vi.mocked(api.duplicateWebhook).mockResolvedValue(makeWebhook("h4", "Payments copy"));
    expect((await store().duplicate("h1"))?.id).toBe("h4");

    store().handleStatus(makeWebhookStatus({ webhookId: "h3" }));
    useWebhooksStore.setState({
      logs: { h3: { entries: [], loaded: true, loading: false, hasMore: false, error: null } },
    });
    await store().remove("h3");
    expect(api.deleteWebhook).toHaveBeenCalledWith("h3");
    expect(tabs().tabs.some((t) => t.doc?.targetId === "h3")).toBe(false);
    expect(store().logs.h3).toBeUndefined();
    expect(store().statuses["w1:h3"]).toBeUndefined();
  });

  it("reports failed writes", async () => {
    vi.mocked(api.createWebhook).mockRejectedValue(new Error("disk full"));
    vi.mocked(api.renameWebhook).mockRejectedValue(new Error("x"));
    vi.mocked(api.duplicateWebhook).mockRejectedValue(new Error("x"));
    vi.mocked(api.deleteWebhook).mockRejectedValue(new Error("x"));
    expect(await store().create("A")).toBeNull();
    await store().rename("h1", "B");
    expect(await store().duplicate("h1")).toBeNull();
    await store().remove("h1");
    expect(toast.error).toHaveBeenCalledTimes(4);
    expect(toast.error).toHaveBeenCalledWith("Couldn't create the webhook", { description: "disk full" });
  });

  it("keeps open tabs in step: names, external edits, deletions", async () => {
    const clean = tabs().openWebhook("h1", "Payments", "w1");
    tabs().markWebhookSaved(clean, hook);
    const edited = tabs().openWebhook("h2", "GitHub", "w1");
    tabs().markWebhookSaved(edited, other);
    tabs().updateWebhook(edited, (w) => ({ ...w, defaultResponse: { ...w.defaultResponse, status: 500 } }));
    const gone = tabs().openWebhook("h9", "Gone", "w1");
    tabs().markWebhookSaved(gone, makeWebhook("h9", "Gone"));
    const goneDirty = tabs().openWebhook("h8", "Gone dirty", "w1");
    tabs().markWebhookSaved(goneDirty, makeWebhook("h8", "Gone dirty"));
    tabs().updateWebhook(goneDirty, (w) => ({ ...w, name: "changed" }));

    const renamedOnDisk = makeWebhook("h1", "Stripe");
    const editedOnDisk = { ...other, defaultResponse: { ...other.defaultResponse, status: 202 } };
    vi.mocked(api.listWebhooks).mockResolvedValue([renamedOnDisk, editedOnDisk]);
    await store().load();

    const byTarget = (id: string) => tabs().tabs.find((t) => t.doc?.targetId === id);
    expect(byTarget("h1")!.doc!.name).toBe("Stripe");
    expect(byTarget("h1")!.doc!.webhook!.draft!.name).toBe("Stripe");
    // The edited tab keeps its edits, compares against the disk version, and says so.
    expect(byTarget("h2")!.doc!.webhook!.draft!.defaultResponse.status).toBe(500);
    expect(byTarget("h2")!.doc!.webhook!.saved!.defaultResponse.status).toBe(202);
    expect(toast.info).toHaveBeenCalled();
    expect(byTarget("h9")).toBeUndefined();
    expect(byTarget("h8")!.doc!.missing).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    await store().load();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(isDirty(byTarget("h8")!)).toBe(true);
    expect(tabTitle(byTarget("h8")!)).toBe("Gone dirty");
  });

  it("opens tabs of running webhooks of other workspaces", () => {
    store().open("h5", "w2", "Elsewhere");
    const t = tabs().tabs.find((x) => x.doc?.targetId === "h5")!;
    expect(t.workspaceId).toBe("w2");
    expect(t.doc!.name).toBe("Elsewhere");
    store().open("h6");
    expect(tabs().tabs.find((x) => x.doc?.targetId === "h6")!.doc!.name).toBe("Webhook");
  });
});

describe("webhooks store: running", () => {
  it("loads statuses and follows status events", async () => {
    vi.mocked(api.webhookStatuses).mockResolvedValue([
      makeWebhookStatus(),
      makeWebhookStatus({ workspaceId: "w2" }),
    ]);
    await store().loadStatuses();
    expect(Object.keys(store().statuses).sort()).toEqual(["w1:h1", "w2:h1"]);
    store().handleStatus(makeWebhookStatus({ state: "stopped" }));
    expect(Object.keys(store().statuses)).toEqual(["w2:h1"]);
    vi.mocked(api.webhookStatuses).mockRejectedValue(new Error("x"));
    await store().loadStatuses();
    expect(Object.keys(store().statuses)).toEqual(["w2:h1"]);
  });

  it("starts and stops, reporting failures", async () => {
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus({ state: "tunnel-starting" }));
    expect(await store().start("h1", true)).toMatchObject({ state: "tunnel-starting" });
    expect(store().statuses["w1:h1"].state).toBe("tunnel-starting");
    await store().stop("w1", "h1");
    expect(api.stopWebhook).toHaveBeenCalledWith("w1", "h1");
    expect(store().statuses["w1:h1"]).toBeUndefined();
    // Stopping one the store doesn't know about.
    await store().stop("w9", "h9");

    vi.mocked(api.startWebhook).mockRejectedValue(new Error("This webhook is already running."));
    expect(await store().start("h1", false)).toBeNull();
    vi.mocked(api.stopWebhook).mockRejectedValue(new Error("x"));
    await store().stop("w1", "h1");
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

describe("webhooks store: logs", () => {
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => makeWebhookRequest(`q${from + i}`));

  it("loads a page, more on request, and live rows on top", async () => {
    vi.mocked(api.webhookRequests)
      .mockResolvedValueOnce(rows(LOG_PAGE))
      .mockResolvedValueOnce(rows(3, LOG_PAGE));
    await store().loadLog("h1");
    expect(api.webhookRequests).toHaveBeenCalledWith("h1", "", LOG_PAGE);
    expect(store().logs.h1).toMatchObject({ loaded: true, hasMore: true });
    await store().loadMore("h1");
    expect(api.webhookRequests).toHaveBeenLastCalledWith("h1", `q${LOG_PAGE - 1}`, LOG_PAGE);
    expect(store().logs.h1.entries).toHaveLength(LOG_PAGE + 3);
    expect(store().logs.h1.hasMore).toBe(false);
    await store().loadMore("h1"); // nothing more
    expect(api.webhookRequests).toHaveBeenCalledTimes(2);

    store().handleRequest("h1", makeWebhookRequest("live"));
    expect(store().logs.h1.entries[0].id).toBe("live");
    store().handleRequest("h1", makeWebhookRequest("live"));
    expect(store().logs.h1.entries.filter((e) => e.id === "live")).toHaveLength(1);
    // A log that isn't open ignores events (it's read from Go when it opens).
    store().handleRequest("h2", makeWebhookRequest("x"));
    expect(store().logs.h2).toBeUndefined();
  });

  it("caps the live log", async () => {
    vi.mocked(api.webhookRequests).mockResolvedValue(rows(10));
    await store().loadLog("h1");
    useWebhooksStore.setState((s) => ({ logs: { ...s.logs, h1: { ...s.logs.h1, entries: rows(LOG_CAP) } } }));
    store().handleRequest("h1", makeWebhookRequest("new"));
    expect(store().logs.h1.entries).toHaveLength(LOG_CAP);
    expect(store().logs.h1.entries[0].id).toBe("new");
  });

  it("reports load errors and skips a load already running", async () => {
    vi.mocked(api.webhookRequests).mockRejectedValueOnce(new Error("db locked"));
    await store().loadLog("h1");
    expect(store().logs.h1).toMatchObject({ loaded: false, loading: false, error: "db locked" });

    let release: (v: never[]) => void = () => {};
    vi.mocked(api.webhookRequests).mockReturnValueOnce(new Promise((r) => (release = r)));
    const p = store().loadLog("h1");
    await store().loadLog("h1");
    release([]);
    await p;
    expect(api.webhookRequests).toHaveBeenCalledTimes(2);

    vi.mocked(api.webhookRequests)
      .mockResolvedValueOnce(rows(LOG_PAGE))
      .mockRejectedValueOnce(new Error("later"));
    await store().loadLog("h1");
    await store().loadMore("h1");
    expect(store().logs.h1.error).toBe("later");
    await store().loadMore("nope");
  });

  it("clears the log and deletes single rows", async () => {
    vi.mocked(api.webhookRequests).mockResolvedValue(rows(3));
    await store().loadLog("h1");
    await store().deleteEntry("h1", "q1");
    expect(api.deleteWebhookRequest).toHaveBeenCalledWith("q1");
    expect(store().logs.h1.entries.map((e) => e.id)).toEqual(["q0", "q2"]);
    await store().deleteEntry("unknown", "q");
    await store().clearLog("h1");
    expect(api.clearWebhookRequests).toHaveBeenCalledWith("h1");
    expect(store().logs.h1.entries).toEqual([]);

    vi.mocked(api.clearWebhookRequests).mockRejectedValue(new Error("x"));
    vi.mocked(api.deleteWebhookRequest).mockRejectedValue(new Error("x"));
    await store().clearLog("h1");
    await store().deleteEntry("h1", "q0");
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

describe("webhooks store: cloudflared", () => {
  it("checks, downloads (with progress), picks and resets cloudflared", async () => {
    expect((await store().checkCloudflared())?.found).toBe(true);

    let finish: (v: unknown) => void = () => {};
    vi.mocked(api.installCloudflared).mockReturnValue(new Promise((r) => (finish = r)) as never);
    const p = store().installCloudflared();
    expect(store().install.running).toBe(true);
    expect(await store().installCloudflared()).toBe(false); // already running
    store().setInstallProgress(10, 100);
    expect(store().install).toEqual({ running: true, done: 10, total: 100 });
    finish({ found: true, version: "2026.11.1", path: "/d/cloudflared", source: "downloaded" });
    expect(await p).toBe(true);
    expect(store().install.running).toBe(false);
    expect(toast.success).toHaveBeenCalled();
    store().setInstallProgress(5, 5); // ignored when not running
    expect(store().install.done).toBe(0);

    await store().cancelInstall();
    expect(api.cancelCloudflaredInstall).toHaveBeenCalled();

    vi.mocked(api.pickCloudflared).mockResolvedValue({ found: true, customPath: "/x" } as never);
    await store().pickCloudflared();
    expect(store().cloudflared?.customPath).toBe("/x");
    vi.mocked(api.setCloudflaredPath).mockResolvedValue({ found: false, customPath: "" } as never);
    await store().setCloudflaredPath("");
    expect(store().cloudflared?.found).toBe(false);
  });

  it("reports cloudflared failures but not a cancel", async () => {
    vi.mocked(api.cloudflaredStatus).mockRejectedValue(new Error("x"));
    expect(await store().checkCloudflared()).toBeNull();
    vi.mocked(api.installCloudflared).mockRejectedValueOnce(new Error("Cancelled."));
    expect(await store().installCloudflared()).toBe(false);
    vi.mocked(api.installCloudflared).mockRejectedValueOnce(new Error("checksum"));
    expect(await store().installCloudflared()).toBe(false);
    vi.mocked(api.pickCloudflared).mockRejectedValue(new Error("x"));
    await store().pickCloudflared();
    vi.mocked(api.setCloudflaredPath).mockRejectedValue(new Error("x"));
    await store().setCloudflaredPath("/y");
    expect(toast.error).toHaveBeenCalledTimes(4);
  });

  it("remembers problems, prompts and selected rules", () => {
    store().setProblem("t", { ruleId: "", field: "status", message: "Bad" });
    expect(store().problems.t?.field).toBe("status");
    store().setCloudflaredPrompt("h1");
    expect(store().cloudflaredPrompt).toBe("h1");
    store().selectRule("t", "r1");
    expect(store().selectedRule.t).toBe("r1");
  });
});
