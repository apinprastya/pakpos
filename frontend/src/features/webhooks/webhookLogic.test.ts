import { toast } from "sonner";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { renderHook } from "@testing-library/react";
import { api, type WorkspaceChange } from "@/lib/api";
import { makeWebhook, makeWebhookRequest, makeWebhookRule, makeWebhookStatus } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { isDirty, tabTitle, useTabsStore } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";
import { saveDocTab } from "@/features/scopes/docActions";
import { saveTab } from "@/features/request/actions";
import { copyText, loadWebhookTab, saveWebhookTab } from "./actions";
import { templateCompletions } from "./completions";
import { startWebhook } from "./start";
import { useWebhooksSync } from "./useWebhooksSync";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const tabs = () => useTabsStore.getState();
const tab = (id: string) => tabs().tabs.find((t) => t.id === id)!;
const ws = { id: "w1", name: "Shop", path: "/shop" };

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
});

describe("webhook tabs", () => {
  it("opens one tab per webhook, tracks its draft and dirtiness", () => {
    const id = tabs().openWebhook("h1", "Payments", "w1");
    expect(tabs().openWebhook("h1", "Payments", "w1")).toBe(id);
    expect(tab(id).doc).toMatchObject({ kind: "webhook", webhook: { draft: null, saved: null } });
    expect(tabTitle(tab(id))).toBe("Payments");
    expect(isDirty(tab(id))).toBe(false);
    // Nothing to edit before it loads.
    tabs().updateWebhook(id, (w) => ({ ...w, name: "x" }));
    expect(tab(id).doc!.webhook!.draft).toBeNull();

    tabs().markWebhookSaved(id, makeWebhook());
    tabs().updateWebhook(id, (w) => ({ ...w, rules: [makeWebhookRule()] }));
    expect(isDirty(tab(id))).toBe(true);
    // A disk version while edited updates only the saved copy.
    tabs().applyWebhookDisk(id, makeWebhook("h1", "Disk"));
    expect(tab(id).doc!.webhook!.draft!.rules).toHaveLength(1);
    expect(tab(id).doc!.webhook!.saved!.name).toBe("Disk");
    tabs().markWebhookSaved(id, makeWebhook("h1", "Saved"));
    expect(isDirty(tab(id))).toBe(false);
    tabs().applyWebhookDisk(id, makeWebhook("h1", "Clean disk"));
    expect(tab(id).doc!.webhook!.draft!.name).toBe("Clean disk");
    tabs().applyWebhookDisk("nope", makeWebhook());
    expect(tabTitle({ ...tab(id), doc: { ...tab(id).doc!, name: "" } })).toBe("Webhook");
  });

  it("restores webhook tabs from storage, dropping a draft without its saved copy", async () => {
    const both = { draft: makeWebhook("h1", "Edited"), saved: makeWebhook() };
    const persisted = {
      state: {
        activeId: "a",
        tabs: [
          { id: "a", doc: { kind: "webhook", targetId: "h1", name: "P", webhook: both }, sections: {} },
          {
            id: "b",
            doc: { kind: "webhook", targetId: "h2", webhook: { draft: makeWebhook() } },
            sections: {},
          },
        ],
      },
      version: 1,
    };
    localStorage.setItem("pakpos-tabs", JSON.stringify(persisted));
    await useTabsStore.persist.rehydrate();
    const [a, b] = tabs().tabs;
    expect(a.doc!.webhook!.draft!.name).toBe("Edited");
    expect(isDirty(a)).toBe(true);
    expect(b.doc).toMatchObject({
      kind: "webhook",
      targetId: "h2",
      name: "",
      webhook: { draft: null, saved: null },
    });
  });
});

describe("webhook tab actions", () => {
  it("loads, saves and routes Mod+S to the webhook save", async () => {
    const id = tabs().openWebhook("h1", "Payments", "w1");
    vi.mocked(api.getWebhook).mockResolvedValue(makeWebhook());
    await loadWebhookTab(id);
    await loadWebhookTab("missing");
    expect(tab(id).doc!.webhook!.saved!.name).toBe("Payments");

    tabs().updateWebhook(id, (w) => ({
      ...w,
      defaultResponse: {
        ...w.defaultResponse,
        headers: [...w.defaultResponse.headers, { key: "", value: "", enabled: true }],
      },
      rules: [makeWebhookRule("new-1")],
    }));
    const saved = makeWebhook("h1", "Payments", { rules: [makeWebhookRule("01J")] });
    vi.mocked(api.saveWebhook).mockResolvedValue({ webhook: saved, problem: null });
    vi.mocked(api.listWebhooks).mockResolvedValue([saved]);
    expect(await saveTab(id)).toBe(true);
    // Blank rows are dropped before saving.
    expect(vi.mocked(api.saveWebhook).mock.calls[0][0].defaultResponse.headers).toHaveLength(1);
    expect(tab(id).doc!.webhook!.saved!.rules[0].id).toBe("01J");
    expect(isDirty(tab(id))).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Payments saved");
    expect(api.listWebhooks).toHaveBeenCalled();
  });

  it("keeps a validation problem for the view and doesn't save", async () => {
    const id = tabs().openWebhook("h1", "Payments", "w1");
    tabs().markWebhookSaved(id, makeWebhook());
    tabs().updateWebhook(id, (w) => ({ ...w, rules: [makeWebhookRule()] }));
    const problem = { ruleId: "r1", field: "path", message: 'Rule 1: the path must start with "/"' };
    vi.mocked(api.saveWebhook).mockResolvedValue({ webhook: null, problem });
    expect(await saveDocTab(id)).toBe(false);
    expect(useWebhooksStore.getState().problems[id]).toEqual(problem);
    expect(toast.error).toHaveBeenCalledWith("Couldn't save Payments", { description: problem.message });
    expect(isDirty(tab(id))).toBe(true);

    // The next good save clears it and can close the tab.
    vi.mocked(api.saveWebhook).mockResolvedValue({ webhook: makeWebhook(), problem: null });
    expect(await saveWebhookTab(id, true)).toBe(true);
    expect(useWebhooksStore.getState().problems[id]).toBeNull();
    expect(tabs().tabs.some((t) => t.id === id)).toBe(false);
  });

  it("refuses to save a deleted webhook, a tab without a draft, and reports errors", async () => {
    const id = tabs().openWebhook("h1", "Payments", "w1");
    expect(await saveWebhookTab(id)).toBe(false);
    tabs().markWebhookSaved(id, makeWebhook());
    tabs().patchDoc(id, { missing: true });
    expect(await saveWebhookTab(id)).toBe(false);
    expect(api.saveWebhook).not.toHaveBeenCalled();
    tabs().patchDoc(id, { missing: false });
    vi.mocked(api.saveWebhook).mockRejectedValue(new Error("disk full"));
    expect(await saveWebhookTab(id)).toBe(false);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't save Payments", { description: "disk full" });
  });

  it("copies text and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await copyText("hello", "URL");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(toast.success).toHaveBeenCalledWith("URL copied");
    writeText.mockRejectedValue(new Error("denied"));
    await copyText("x", "URL");
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the url", { description: "denied" });
  });
});

describe("startWebhook", () => {
  it("starts local only without checking cloudflared", async () => {
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus({ tunnel: false }));
    expect(await startWebhook("h1", false)).toBe(true);
    expect(api.cloudflaredStatus).not.toHaveBeenCalled();
    expect(api.startWebhook).toHaveBeenCalledWith("h1", false);
  });

  it("opens the download panel when cloudflared is missing", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue({ found: false } as never);
    expect(await startWebhook("h1", true)).toBe(false);
    expect(api.startWebhook).not.toHaveBeenCalled();
    expect(useWebhooksStore.getState().cloudflaredPrompt).toBe("h1");
    expect(tabs().tabs.some((t) => t.doc?.targetId === "h1")).toBe(true);

    vi.mocked(api.cloudflaredStatus).mockRejectedValue(new Error("x"));
    expect(await startWebhook("h1", true)).toBe(false);
  });

  it("starts with a tunnel when cloudflared is there", async () => {
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus({ state: "tunnel-starting" }));
    useWebhooksStore.getState().setCloudflaredPrompt("h1");
    expect(await startWebhook("h1", true)).toBe(true);
    expect(useWebhooksStore.getState().cloudflaredPrompt).toBeNull();
    vi.mocked(api.startWebhook).mockRejectedValue(new Error("busy"));
    expect(await startWebhook("h1", true)).toBe(false);
  });
});

describe("templateCompletions", () => {
  function complete(text: string, explicit = false): CompletionResult | null {
    const state = EditorState.create({ doc: text });
    return templateCompletions(
      new CompletionContext(state, text.length, explicit),
    ) as CompletionResult | null;
  }

  it("offers request fields and dynamic variables after {{", () => {
    const res = complete('{"id": "{{$req');
    expect(res?.from).toBe('{"id": "{{'.length);
    const labels = res!.options.map((o) => o.label);
    expect(labels).toContain("$request.json.");
    expect(labels).toContain("$randomUUID");
    expect(res!.options.find((o) => o.label === "$timestamp")!.apply).toBe("$timestamp}}");
    expect(res!.options.find((o) => o.label === "$request.query.")!.apply).toBe("$request.query.");
    expect(complete("{{ ")?.from).toBe(3);
    expect(complete("no braces")).toBeNull();
    expect(complete("{{done}} x")).toBeNull();
  });
});

describe("useWebhooksSync", () => {
  it("subscribes to events, loads statuses and reloads on workspace changes", async () => {
    let onStatus: (s: ReturnType<typeof makeWebhookStatus>) => void = () => {};
    let onRequest: (ev: {
      workspaceId: string;
      webhookId: string;
      entry: ReturnType<typeof makeWebhookRequest>;
    }) => void = () => {};
    let onInstall: (p: { done: number; total: number }) => void = () => {};
    const changed: ((c: WorkspaceChange) => void)[] = [];
    vi.mocked(api.onWebhookStatus).mockImplementation((cb) => ((onStatus = cb), () => {}));
    vi.mocked(api.onWebhookRequest).mockImplementation((cb) => ((onRequest = cb), () => {}));
    vi.mocked(api.onCloudflaredInstall).mockImplementation((cb) => ((onInstall = cb), () => {}));
    vi.mocked(api.onWorkspaceChanged).mockImplementation((cb) => (changed.push(cb), () => {}));
    vi.mocked(api.webhookStatuses).mockResolvedValue([makeWebhookStatus()]);

    const { unmount } = renderHook(() => useWebhooksSync());
    await vi.waitFor(() => expect(useWebhooksStore.getState().status).toBe("ready"));
    await vi.waitFor(() => expect(useWebhooksStore.getState().statuses["w1:h1"]).toBeDefined());

    onStatus(makeWebhookStatus({ state: "stopped" }));
    expect(useWebhooksStore.getState().statuses["w1:h1"]).toBeUndefined();

    useWebhooksStore.setState({
      logs: { h1: { entries: [], loaded: true, loading: false, hasMore: false, error: null } },
    });
    onRequest({ workspaceId: "w1", webhookId: "h1", entry: makeWebhookRequest() });
    expect(useWebhooksStore.getState().logs.h1.entries).toHaveLength(1);

    useWebhooksStore.setState({ install: { running: true, done: 0, total: 0 } });
    onInstall({ done: 5, total: 10 });
    expect(useWebhooksStore.getState().install.done).toBe(5);

    const before = vi.mocked(api.listWebhooks).mock.calls.length;
    changed.forEach((cb) => cb({ workspaceId: "other", problems: [] }));
    changed.forEach((cb) => cb({ workspaceId: "w1", problems: [] }));
    await vi.waitFor(() => expect(vi.mocked(api.listWebhooks).mock.calls.length).toBe(before + 1));
    unmount();
  });
});
