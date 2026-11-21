import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { useLayoutStore } from "@/stores/layout";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";
import { makeWebhook, makeWebhookStatus } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { ACTIONS, availableActions, type ActionContext } from "./actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const action = (id: string) => ACTIONS.find((a) => a.id === id)!;
const webhookIds = (c: ActionContext) =>
  availableActions(c)
    .map((a) => a.id)
    .filter((id) => id.includes("webhook"));

function webhookTab(workspaceId = "w1"): Tab {
  resetTabs();
  const id = useTabsStore.getState().openWebhook("h1", "Payments", workspaceId);
  return useTabsStore.getState().tabs.find((t) => t.id === id)!;
}

function ctx(tab: Tab, workspace: typeof ws | null = ws): ActionContext {
  return { tab, workspace, secrets: null, goTo: vi.fn(), confirm: vi.fn() };
}

beforeEach(() => {
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("webhook palette actions", () => {
  it("offers new/open with a workspace, and start on a stopped webhook tab", () => {
    expect(webhookIds(ctx(resetTabs(emptyRequest())))).toEqual(["new-webhook", "open-webhooks"]);
    expect(webhookIds(ctx(resetTabs(emptyRequest()), null))).toEqual(["open-webhooks"]);
    expect(webhookIds(ctx(webhookTab()))).toEqual([
      "new-webhook",
      "open-webhooks",
      "start-webhook",
      "start-webhook-local",
    ]);
    // A webhook of another workspace can't be started from here.
    expect(webhookIds(ctx(webhookTab("w2")))).toEqual(["new-webhook", "open-webhooks"]);
  });

  it("offers stop and copy on a running webhook tab", async () => {
    const tab = webhookTab();
    useWebhooksStore.getState().handleStatus(makeWebhookStatus());
    expect(webhookIds(ctx(tab))).toEqual([
      "new-webhook",
      "open-webhooks",
      "stop-webhook",
      "copy-webhook-url",
    ]);
    action("copy-webhook-url").run(ctx(tab));
    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://brave-fox.trycloudflare.com"),
    );
    action("stop-webhook").run(ctx(tab));
    await vi.waitFor(() => expect(api.stopWebhook).toHaveBeenCalledWith("w1", "h1"));
  });

  it("runs new, open and start", async () => {
    vi.mocked(api.createWebhook).mockResolvedValue(makeWebhook("h3", "New webhook"));
    useLayoutStore.getState().setSidebarView("history");
    action("open-webhooks").run(ctx(resetTabs()));
    expect(useLayoutStore.getState().sidebarView).toBe("webhooks");
    action("new-webhook").run(ctx(resetTabs()));
    await vi.waitFor(() => expect(api.createWebhook).toHaveBeenCalled());

    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus());
    const tab = webhookTab();
    action("start-webhook-local").run(ctx(tab));
    await vi.waitFor(() => expect(api.startWebhook).toHaveBeenCalledWith("h1", false));
    action("start-webhook").run(ctx(tab));
    await vi.waitFor(() => expect(api.startWebhook).toHaveBeenCalledWith("h1", true));
  });
});
