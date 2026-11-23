import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import {
  makeWebhook,
  makeWebhookDetail,
  makeWebhookRequest,
  makeWebhookRule,
  makeWebhookStatus,
} from "@/test/fixtures";
import { editorText, setEditorText } from "@/test/editor";
import { resetTabs } from "@/test/store";
import { ActivityRail } from "@/features/shell/ActivityRail";
import { useLayoutStore } from "@/stores/layout";
import { useTabsStore } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";
import { WebhooksSidebar } from "./WebhooksSidebar";
import { WebhookView } from "./WebhookView";
import { WebhookView as LazyWebhookView } from "./lazy";
import { clockTime, matchesFilter, moveRule, ruleSummary, statusText } from "./format";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tabs = () => useTabsStore.getState();
const store = () => useWebhooksStore.getState();
const writeText = vi.fn().mockResolvedValue(undefined);

/** userEvent.setup() installs its own clipboard; put the spy back after it. */
function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return user;
}

beforeEach(() => {
  resetTabs();
  writeText.mockClear();
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  vi.mocked(api.listWebhooks).mockResolvedValue([makeWebhook(), makeWebhook("h2", "GitHub")]);
});

function wrap(ui: React.ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("WebhooksSidebar", () => {
  it("asks for a workspace first", () => {
    useWorkspaceStore.setState({ workspace: null, status: "none" });
    wrap(<WebhooksSidebar />);
    expect(screen.getByText("No workspace open")).toBeInTheDocument();
    screen.getByRole("button", { name: "Go to collections" }).click();
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
  });

  it("shows loading, errors and the empty state", async () => {
    useWorkspaceStore.setState({ status: "loading" });
    const { unmount } = wrap(<WebhooksSidebar />);
    expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
    unmount();

    useWorkspaceStore.setState({ status: "ready" });
    useWebhooksStore.setState({ status: "error", error: "boom" });
    const user = setup();
    const second = wrap(<WebhooksSidebar />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(store().status).toBe("ready"));
    second.unmount();

    useWebhooksStore.setState({ status: "ready", webhooks: [] });
    vi.mocked(api.createWebhook).mockResolvedValue(makeWebhook("h3", "New webhook"));
    wrap(<WebhooksSidebar />);
    await user.click(screen.getByRole("button", { name: "Create webhook" }));
    expect(api.createWebhook).toHaveBeenCalled();
  });

  it("lists webhooks with their state and opens, renames, starts and deletes them", async () => {
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus({ webhookId: "h2", tunnel: false }));
    vi.mocked(api.renameWebhook).mockResolvedValue(makeWebhook("h1", "Stripe"));
    await store().load();
    store().handleStatus(makeWebhookStatus());
    const user = setup();
    wrap(<WebhooksSidebar />);
    const list = screen.getByRole("list", { name: "Webhooks" });
    expect(within(list).getByRole("img", { name: "Running" })).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /^Payments/ }));
    expect(tabs().tabs.find((t) => t.id === tabs().activeId)!.doc).toMatchObject({
      kind: "webhook",
      targetId: "h1",
    });

    // F2 renames inline.
    within(list)
      .getByRole("button", { name: /^Payments/ })
      .focus();
    await user.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: "Webhook name" });
    await user.clear(input);
    await user.type(input, "Stripe{Enter}");
    expect(api.renameWebhook).toHaveBeenCalledWith("h1", "Stripe");

    // The menu starts a stopped one locally.
    await user.click(screen.getByRole("button", { name: "More actions for GitHub" }));
    await user.click(await screen.findByRole("menuitem", { name: "Start local only" }));
    expect(api.startWebhook).toHaveBeenCalledWith("h2", false);

    // Delete asks first.
    await user.click(screen.getByRole("button", { name: "More actions for GitHub" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Delete/ }));
    await user.click(await screen.findByRole("button", { name: "Delete webhook" }));
    expect(api.deleteWebhook).toHaveBeenCalledWith("h2");
  });

  it("offers stop and copy for a running webhook, and Delete from the keyboard", async () => {
    await store().load();
    store().handleStatus(makeWebhookStatus());
    const user = setup();
    wrap(<WebhooksSidebar />);
    await user.click(screen.getByRole("button", { name: "More actions for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy URL" }));
    expect(writeText).toHaveBeenCalledWith("https://brave-fox.trycloudflare.com");
    await user.click(screen.getByRole("button", { name: "More actions for Payments" }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop" }));
    expect(api.stopWebhook).toHaveBeenCalledWith("w1", "h1");

    screen.getByRole("button", { name: /^GitHub/ }).focus();
    await user.keyboard("{Delete}");
    expect(await screen.findByRole("alertdialog")).toHaveTextContent('Delete the webhook "GitHub"?');
  });

  it("shows webhooks still running in other workspaces", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue({ found: true } as never);
    await store().load();
    store().handleStatus(
      makeWebhookStatus({ workspaceId: "w2", webhookId: "h9", name: "Old hook", workspaceName: "Legacy" }),
    );
    const user = setup();
    wrap(<WebhooksSidebar />);
    const group = screen.getByRole("region", { name: "Running in other workspaces" });
    expect(within(group).getByText("Legacy")).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Copy the URL of Old hook" }));
    expect(writeText).toHaveBeenCalled();
    await user.click(within(group).getByRole("button", { name: "Open the log of Old hook" }));
    const active = tabs().tabs.find((t) => t.id === tabs().activeId)!;
    expect(active).toMatchObject({ workspaceId: "w2", doc: { targetId: "h9", name: "Old hook" } });
    await user.click(within(group).getByRole("button", { name: "Stop Old hook" }));
    expect(api.stopWebhook).toHaveBeenCalledWith("w2", "h9");
  });
});

describe("ActivityRail", () => {
  it("shows how many webhooks are running", async () => {
    wrap(<ActivityRail />);
    expect(screen.getByRole("button", { name: "Webhooks" })).toBeInTheDocument();
    act(() => store().handleStatus(makeWebhookStatus()));
    expect(screen.getByRole("button", { name: "Webhooks (1 running)" })).toBeInTheDocument();
  });
});

function Active() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)!);
  // Like AppShell: only webhook tabs render the webhook view.
  return tab.doc?.kind === "webhook" ? <WebhookView tab={tab} /> : null;
}

function openTab(webhook = makeWebhook(), workspaceId = "w1") {
  vi.mocked(api.getWebhook).mockResolvedValue(webhook);
  tabs().openWebhook(webhook.id, webhook.name, workspaceId);
  return setup();
}

describe("WebhookView", () => {
  it("describes each state", () => {
    expect(statusText(undefined)).toBe("Stopped");
    expect(statusText(makeWebhookStatus({ state: "tunnel-starting" }))).toBe("Starting the public tunnel…");
    expect(statusText(makeWebhookStatus({ state: "tunnel-failed", message: "boom" }))).toBe("boom");
    expect(statusText(makeWebhookStatus({ state: "tunnel-failed", message: "" }))).toBe(
      "The tunnel stopped.",
    );
    expect(statusText(makeWebhookStatus())).toBe("Live on a public URL");
    expect(statusText(makeWebhookStatus({ tunnel: false }))).toBe("Running on this computer only");
  });

  it("loads lazily, starts with a tunnel or locally, shows the URL and stops", async () => {
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus());
    const user = openTab();
    const tab = tabs().tabs.find((t) => t.id === tabs().activeId)!;
    wrap(<LazyWebhookView tab={tab} />);
    expect(
      await screen.findByRole("status", { name: "" }, { timeout: 3000 }).catch(() => null),
    ).toBeDefined();
    await screen.findByRole("heading", { name: "Payments" });
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(await screen.findByText("No requests yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(api.startWebhook).toHaveBeenCalledWith("h1", true);
    expect(await screen.findByText("https://brave-fox.trycloudflare.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(writeText).toHaveBeenCalledWith("https://brave-fox.trycloudflare.com");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.stopWebhook).toHaveBeenCalledWith("w1", "h1");
    await user.click(await screen.findByRole("button", { name: "More ways to start" }));
    await user.click(await screen.findByRole("menuitem", { name: "Start local only" }));
    expect(api.startWebhook).toHaveBeenLastCalledWith("h1", false);
  });

  it("shows the cloudflared panel when it's missing, and starts once it's downloaded", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue({ found: false, canDownload: true } as never);
    let finish: (v: unknown) => void = () => {};
    vi.mocked(api.installCloudflared).mockReturnValue(new Promise((r) => (finish = r)) as never);
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus());
    const user = openTab();
    wrap(<Active />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    const panel = await screen.findByRole("region", { name: "cloudflared is needed" });
    expect(api.startWebhook).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: "Download cloudflared" }));
    act(() => store().setInstallProgress(512, 2048));
    expect(within(panel).getByRole("progressbar", { name: "Downloading cloudflared" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(within(panel).getByText("512 B of 2.0 KB")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(api.cancelCloudflaredInstall).toHaveBeenCalled();

    vi.mocked(api.cloudflaredStatus).mockResolvedValue({ found: true } as never);
    await act(async () => finish({ found: true, version: "2026.11.1" }));
    await waitFor(() => expect(api.startWebhook).toHaveBeenCalledWith("h1", true));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "cloudflared is needed" })).not.toBeInTheDocument(),
    );
  });

  it("lets the user pick cloudflared, start local only, or close the panel", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue({ found: false, canDownload: false } as never);
    vi.mocked(api.pickCloudflared).mockResolvedValue({
      found: false,
      customPath: "/x",
      error: "doesn't run",
    } as never);
    vi.mocked(api.startWebhook).mockResolvedValue(makeWebhookStatus({ tunnel: false, publicUrl: "" }));
    const user = openTab();
    wrap(<Active />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    const panel = await screen.findByRole("region", { name: "cloudflared is needed" });
    expect(within(panel).queryByRole("button", { name: "Download cloudflared" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Choose file…" }));
    expect(await within(panel).findByText("doesn't run")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Start local only" }));
    expect(api.startWebhook).toHaveBeenCalledWith("h1", false);
    expect(await screen.findByText("Local URL")).toBeInTheDocument();

    act(() => store().setCloudflaredPrompt("h1"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(store().cloudflaredPrompt).toBeNull();
  });

  it("shows the panel when a tunnel failed because cloudflared is gone", async () => {
    openTab();
    store().handleStatus(
      makeWebhookStatus({ state: "tunnel-failed", message: "cloudflared isn't installed. Download it" }),
    );
    wrap(<Active />);
    expect(await screen.findByRole("region", { name: "cloudflared is needed" })).toBeInTheDocument();
  });

  it("is read-only for a webhook of another workspace", async () => {
    openTab(makeWebhook("h9", "Old hook"), "w2");
    store().handleStatus(makeWebhookStatus({ workspaceId: "w2", webhookId: "h9", workspaceName: "Legacy" }));
    wrap(<Active />);
    expect(await screen.findByRole("note")).toHaveTextContent("belongs to “Legacy”");
    expect(screen.queryByRole("tab", { name: /Rules/ })).not.toBeInTheDocument();
    expect(api.getWebhook).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("reports a webhook that can't be loaded and one deleted outside the app", async () => {
    vi.mocked(api.getWebhook).mockRejectedValue(new Error("not found"));
    tabs().openWebhook("h1", "Payments", "w1");
    const user = setup();
    wrap(<Active />);
    await user.click(screen.getByRole("tab", { name: "Rules" }));
    expect(await screen.findByText("Couldn't load the webhook: not found")).toBeInTheDocument();
    act(() => tabs().patchDoc(tabs().activeId, { missing: true }));
    expect(screen.getByRole("alert")).toHaveTextContent("deleted outside the app");
  });
});

describe("RequestLog", () => {
  const entries = [
    makeWebhookRequest("q2", {
      method: "GET",
      path: "/health",
      status: 204,
      ruleName: "Health",
      ruleId: "r9",
    }),
    makeWebhookRequest("q1", { query: "a=1", status: 400, error: "Body too large" }),
  ];

  beforeEach(() => {
    vi.mocked(api.webhookRequests).mockResolvedValue(entries);
    vi.mocked(api.webhookRequest).mockImplementation(async (id) =>
      makeWebhookDetail(entries.find((e) => e.id === id)!),
    );
    store().handleStatus(makeWebhookStatus());
  });

  it("filters helpers", () => {
    expect(matchesFilter(entries[0], "")).toBe(true);
    expect(matchesFilter(entries[0], "health")).toBe(true);
    expect(matchesFilter(entries[1], "default")).toBe(true);
    expect(matchesFilter(entries[1], "204")).toBe(false);
    expect(clockTime("nope")).toBe("");
    expect(clockTime("2026-11-21T10:00:05Z")).not.toBe("");
  });

  it("lists requests, shows the selected one, filters and loads live rows", async () => {
    const user = openTab();
    wrap(<Active />);
    const list = await screen.findByRole("list", { name: "Requests" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    const details = await screen.findByRole("region", { name: "Request details" });
    expect(within(details).getByText("/health")).toBeInTheDocument();
    expect(within(details).getByText(/by rule “Health”/)).toBeInTheDocument();
    expect(await within(details).findByRole("table", { name: "Request headers" })).toHaveTextContent(
      "Stripe-Signature",
    );
    await waitFor(() => expect(editorText("Request body")).toBe('{"type":"paid"}'));

    await user.click(within(list).getByRole("button", { name: /stripe\/events\?a=1/ }));
    expect(
      await within(screen.getByRole("region", { name: "Request details" })).findByText("Body too large"),
    ).toBeInTheDocument();
    expect(screen.getByText(/with the default response/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Reply sent" }));
    expect(await screen.findByRole("table", { name: "Reply headers" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Filter requests" }), "zzz");
    expect(screen.getByText("No requests match “zzz”.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Filter requests" }));

    act(() => store().handleRequest("h1", makeWebhookRequest("q3", { path: "/new" })));
    expect(within(list).getAllByRole("button")).toHaveLength(3);
  });

  it("copies cURL and the body, opens as a request, creates a rule and deletes", async () => {
    const user = openTab();
    wrap(<Active />);
    const details = await screen.findByRole("region", { name: "Request details" });
    await waitFor(() => expect(within(details).getByRole("button", { name: /Copy as cURL/ })).toBeEnabled());
    await user.click(within(details).getByRole("button", { name: /Copy as cURL/ }));
    expect(writeText.mock.calls[0][0]).toContain("curl \\\n  'https://brave-fox.trycloudflare.com/health'");
    await user.click(within(details).getByRole("button", { name: /Copy body/ }));
    expect(writeText).toHaveBeenLastCalledWith('{"type":"paid"}');

    await user.click(within(details).getByRole("button", { name: /Open as request/ }));
    const opened = tabs().tabs.find((t) => t.id === tabs().activeId)!;
    expect(opened.request).toMatchObject({
      method: "GET",
      url: "https://brave-fox.trycloudflare.com/health",
    });
    act(() => tabs().activate(tabs().tabs.find((t) => t.doc?.kind === "webhook")!.id));

    await user.click(await screen.findByRole("button", { name: /Create rule/ }));
    expect(await screen.findByRole("textbox", { name: "Path" })).toHaveValue("/health");
    const webhookTab = tabs().tabs.find((t) => t.doc?.kind === "webhook")!;
    expect(webhookTab.doc!.webhook!.draft!.rules[0]).toMatchObject({
      name: "GET /health",
      match: { method: "GET" },
    });

    await user.click(screen.getByRole("tab", { name: /Requests/ }));
    await user.click(await screen.findByRole("button", { name: "Delete this request" }));
    expect(api.deleteWebhookRequest).toHaveBeenCalledWith("q2");
  });

  it("clears the log after confirming, and pages older rows", async () => {
    vi.mocked(api.webhookRequests).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => makeWebhookRequest(`p${i}`)),
    );
    const user = openTab();
    wrap(<Active />);
    await user.click(await screen.findByRole("button", { name: "Load older" }));
    expect(api.webhookRequests).toHaveBeenLastCalledWith("h1", "p99", 100);
    await user.click(screen.getByRole("button", { name: "Clear log" }));
    await user.click(await screen.findByRole("button", { name: "Clear log" }));
    expect(api.clearWebhookRequests).toHaveBeenCalledWith("h1");
    expect(await screen.findByText("No requests yet.")).toBeInTheDocument();
  });

  it("explains binary, truncated and missing bodies, and load errors", async () => {
    vi.mocked(api.webhookRequest).mockResolvedValueOnce(
      makeWebhookDetail(entries[0], {
        headers: [],
        body: { text: "", base64: "AAAA", binary: true, truncated: true },
        responseBody: { text: "", base64: "", binary: false, truncated: false },
      }),
    );
    const user = openTab();
    wrap(<Active />);
    expect(await screen.findByText("Binary data (3 B), not shown.")).toBeInTheDocument();
    expect(screen.getByText("Only the first 1 MB was kept")).toBeInTheDocument();
    expect(screen.getByText("No headers")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Reply sent" }));
    expect(screen.getByText("No body")).toBeInTheDocument();

    vi.mocked(api.webhookRequest).mockRejectedValueOnce(new Error("gone"));
    await user.click(within(screen.getByRole("list", { name: "Requests" })).getAllByRole("button")[1]);
    expect(await screen.findByText(/Couldn't load the request: gone/)).toBeInTheDocument();
  });

  it("shows log load errors", async () => {
    vi.mocked(api.webhookRequests).mockRejectedValue(new Error("db locked"));
    openTab();
    wrap(<Active />);
    expect(await screen.findByText("Couldn't load the requests: db locked")).toBeInTheDocument();
  });
});

describe("RulesEditor", () => {
  it("helpers move and describe rules", () => {
    const a = makeWebhookRule("a");
    const b = makeWebhookRule("b", {
      match: { method: "ANY", path: "", conditions: [{ source: "body", name: "", op: "exists", value: "" }] },
    });
    expect(moveRule([a, b], 0, 1).map((r) => r.id)).toEqual(["b", "a"]);
    expect(moveRule([a, b], 0, 5)).toEqual([a, b]);
    expect(ruleSummary(a)).toBe("POST /stripe/* · 400");
    expect(ruleSummary(b)).toBe("Any / +1 · 400");
  });

  async function openRules(
    webhook = makeWebhook("h1", "Payments", {
      rules: [makeWebhookRule("r1"), makeWebhookRule("r2", { name: "" })],
    }),
  ) {
    const user = openTab(webhook);
    wrap(<Active />);
    await user.click(screen.getByRole("tab", { name: /Rules/ }));
    await screen.findByRole("list", { name: "Rule order" });
    const draft = () => tabs().tabs.find((t) => t.doc?.kind === "webhook")!.doc!.webhook!.draft!;
    return { user, draft };
  }

  it("edits the selected rule's match and reply", async () => {
    const { user, draft } = await openRules();
    const name = screen.getByRole("textbox", { name: "Rule name" });
    await user.clear(name);
    await user.type(name, "Fail");
    const path = screen.getByRole("textbox", { name: "Path" });
    await user.clear(path);
    await user.type(path, "/pay/:id");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.type(screen.getByRole("textbox", { name: "Condition 1 name" }), "X-Kind");
    await user.type(screen.getByRole("textbox", { name: "Condition 1 value" }), "b");
    // Focusing selects the whole value, so typing replaces it.
    const status = screen.getByRole("textbox", { name: "Status" });
    await user.click(status);
    await user.keyboard("402");
    const delay = screen.getByRole("textbox", { name: "Delay (ms)" });
    await user.click(delay);
    await user.keyboard("2a5x0");
    setEditorText("Reply body", '{"id": "{{$request.params.id}}"}');

    const r = draft().rules[0];
    expect(r).toMatchObject({
      name: "Fail",
      match: {
        path: "/pay/:id",
        conditions: [{ source: "header", name: "X-Kind", op: "equals", value: "b" }],
      },
      response: { status: 402, delayMs: 250, body: '{"id": "{{$request.params.id}}"}' },
    });

    // Clearing doesn't turn it into 0; leaving it empty puts the value back.
    await user.clear(status);
    expect(status).toHaveValue("");
    expect(draft().rules[0].response.status).toBe(402);
    await user.tab();
    expect(status).toHaveValue("402");
    await user.click(screen.getByRole("button", { name: "Remove condition 1" }));
    expect(draft().rules[0].match.conditions).toEqual([]);
    await user.click(screen.getByRole("checkbox", { name: "Enabled" }));
    expect(draft().rules[0].enabled).toBe(false);
  });

  it("changes method, source and test through the selects", async () => {
    const { user, draft } = await openRules();
    screen.getByRole("combobox", { name: "Method" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Any method" }));
    expect(draft().rules[0].match.method).toBe("ANY");

    await user.click(screen.getByRole("button", { name: "Add condition" }));
    screen.getByRole("combobox", { name: "Condition 1 source" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Body" }));
    expect(screen.queryByRole("textbox", { name: "Condition 1 name" })).not.toBeInTheDocument();
    screen.getByRole("combobox", { name: "Condition 1 test" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "exists" }));
    expect(screen.queryByRole("textbox", { name: "Condition 1 value" })).not.toBeInTheDocument();
    expect(draft().rules[0].match.conditions[0]).toMatchObject({ source: "body", op: "exists" });
  });

  it("adds, reorders, enables, deletes rules and edits the default response", async () => {
    const { user, draft } = await openRules();
    await user.click(screen.getByRole("button", { name: "Move Declined down" }));
    expect(draft().rules.map((r) => r.id)).toEqual(["r2", "r1"]);
    await user.click(screen.getByRole("button", { name: "Move Declined up" }));
    expect(draft().rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    // Alt+Arrow on a rule moves it too.
    within(screen.getByRole("list", { name: "Rule order" }))
      .getByRole("button", { name: /^Declined/ })
      .focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(draft().rules.map((r) => r.id)).toEqual(["r2", "r1"]);

    await user.click(screen.getByRole("checkbox", { name: "Enable rule 1" }));
    expect(draft().rules[0].enabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(draft().rules).toHaveLength(3);
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("/");
    await user.click(screen.getByRole("button", { name: /Delete rule/ }));
    expect(draft().rules).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /Default response/ }));
    const status = await screen.findByRole("textbox", { name: "Status" });
    await user.tripleClick(status);
    await user.keyboard("204");
    expect(draft().defaultResponse.status).toBe(204);
  });

  it("shows an empty state and a save problem on its rule", async () => {
    const webhook = makeWebhook("h1", "Payments", { rules: [makeWebhookRule("r1")] });
    const { user } = await openRules(webhook);
    act(() =>
      store().setProblem(tabs().activeId, {
        ruleId: "r1",
        field: "conditions.0.value",
        message: "Rule 1: bad regex",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Rule 1: bad regex");
    await user.click(screen.getByRole("button", { name: /Delete rule/ }));
    expect(screen.getByText(/No rules yet/)).toBeInTheDocument();
    act(() =>
      store().setProblem(tabs().activeId, { ruleId: "", field: "status", message: "Default response: bad" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Default response: bad");
    expect(screen.getByRole("textbox", { name: "Status" })).toHaveAttribute("aria-invalid", "true");
  });

  it("saves from the header when edited", async () => {
    vi.mocked(api.saveWebhook).mockResolvedValue({ webhook: makeWebhook(), problem: null });
    const { user } = await openRules();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.saveWebhook).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });
});
