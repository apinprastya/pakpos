import { api } from "@/lib/api";
import { emptyRequest, type SecretsStatus } from "@/lib/model";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useEnvironmentsStore } from "@/stores/environments";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";
import { useSecretsStore } from "@/stores/secrets";
import { useSettingsStore } from "@/stores/settings";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { useThemeStore } from "@/stores/theme";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { col, req } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { ACTIONS, availableActions, type ActionContext } from "./actions";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const ws = { id: "w1", name: "Shop", path: "/shop" };
const savedReq = { ...emptyRequest(), id: "r1", name: "List", url: "https://api/users" };

function ctx(patch: Partial<ActionContext> = {}, tab?: Tab): ActionContext {
  return {
    tab: tab ?? resetTabs(savedReq, { saved: savedReq, parentId: "c1", workspaceId: "w1" }),
    workspace: ws,
    secrets: { backend: "keychain", hasPassword: false, locked: false },
    goTo: vi.fn(),
    confirm: vi.fn(),
    ...patch,
  };
}

const ids = (c: ActionContext) => availableActions(c).map((a) => a.id);
const action = (id: string) => ACTIONS.find((a) => a.id === id)!;

beforeEach(() => {
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    collections: [col("c1", "Users", [req("r1")])],
  });
});

describe("palette actions", () => {
  it("have unique ids, labels in sentence case and a group", () => {
    const seen = new Set<string>();
    for (const a of ACTIONS) {
      expect(seen.has(a.id)).toBe(false);
      seen.add(a.id);
      expect(a.label[0]).toBe(a.label[0].toUpperCase());
      expect(a.group).not.toBe("");
    }
    expect(action("save").shortcut!()).toMatch(/\+S$/);
  });

  it("offer only what applies", () => {
    const all = ids(ctx());
    expect(all).toEqual(
      expect.arrayContaining(["move-request", "reveal-request", "new-folder", "switch-environment"]),
    );
    expect(all).not.toContain("lock-secrets");

    // Without a workspace: no workspace-bound actions.
    const none = ids(ctx({ workspace: null }, resetTabs({ url: "https://x" })));
    expect(none).toEqual(
      expect.arrayContaining(["new-request", "open-workspace", "create-workspace", "toggle-theme"]),
    );
    for (const id of [
      "close-workspace",
      "switch-environment",
      "move-request",
      "new-collection",
      "edit-globals",
    ]) {
      expect(none).not.toContain(id);
    }

    // An unsaved draft without a URL: no move, reveal, new folder or copy as cURL.
    const draft = ids(ctx({}, resetTabs()));
    expect(draft).not.toContain("move-request");
    expect(draft).not.toContain("copy-curl");
    expect(draft).toContain("generate-code");

    // A settings tab: no request actions.
    const doc = resetTabs(
      {},
      { doc: { kind: "globals", targetId: "", name: "Globals", draft: null, saved: null, missing: false } },
    );
    expect(ids(ctx({}, doc))).not.toContain("save-as");
  });

  it.each<[string, SecretsStatus, string[], string[]]>([
    [
      "keychain",
      { backend: "keychain", hasPassword: false, locked: false },
      [],
      ["lock-secrets", "unlock-secrets", "change-master-password"],
    ],
    [
      "file, locked",
      { backend: "file", hasPassword: true, locked: true },
      ["unlock-secrets", "change-master-password"],
      ["lock-secrets"],
    ],
    [
      "file, unlocked",
      { backend: "file", hasPassword: true, locked: false },
      ["lock-secrets", "change-master-password"],
      ["unlock-secrets"],
    ],
    [
      "file, no password",
      { backend: "file", hasPassword: false, locked: false },
      [],
      ["lock-secrets", "unlock-secrets", "change-master-password"],
    ],
  ])("secret actions with the %s store", (_, secrets, yes, no) => {
    const list = ids(ctx({ secrets }));
    for (const id of yes) expect(list).toContain(id);
    for (const id of no) expect(list).not.toContain(id);
  });

  it("run request actions", async () => {
    const c = ctx();
    action("new-request").run(c);
    expect(useTabsStore.getState().tabs).toHaveLength(2);

    const c2 = ctx();
    action("save").run(c2);
    await vi.waitFor(() => expect(api.save).toHaveBeenCalled());
    action("save-as").run(c2);
    expect(useTabsStore.getState().saveDialog).toEqual({ tabId: "t1", closeAfter: false });
    action("generate-code").run(c2);
    expect(useCodeDialogsStore.getState().codeTabId).toBe("t1");
    action("import-curl").run(c2);
    expect(useCodeDialogsStore.getState().importOpen).toBe(true);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.mocked(api.generateCode).mockResolvedValue({
      code: "curl x",
      unresolved: [],
      masked: [],
      secretsLocked: false,
      warnings: [],
      environment: null,
    });
    action("copy-curl").run(c2);
    await vi.waitFor(() =>
      expect(api.generateCode).toHaveBeenCalledWith(expect.anything(), "c1", "curl", expect.anything()),
    );
    const c3 = ctx();
    action("close-tab").run(c3);
    expect(useTabsStore.getState().tabs.find((t) => t.id === "t1")).toBeUndefined();
  });

  it("open second steps and ask before clearing history", () => {
    const c = ctx();
    action("move-request").run(c);
    action("switch-environment").run(c);
    expect(c.goTo).toHaveBeenNthCalledWith(1, "move");
    expect(c.goTo).toHaveBeenNthCalledWith(2, "environment");

    const clear = vi.spyOn(useHistoryStore.getState(), "clear").mockResolvedValue();
    action("clear-history").run(c);
    const target = vi.mocked(c.confirm).mock.calls[0][0];
    expect(target.title).toBe("Clear history of Shop?");
    target.onConfirm();
    expect(clear).toHaveBeenCalled();
    const c2 = ctx({ workspace: null });
    action("clear-history").run(c2);
    expect(vi.mocked(c2.confirm).mock.calls[0][0].description).toMatch(/without a workspace/);
  });

  it("run workspace, tree and environment actions", () => {
    const store = useWorkspaceStore.getState();
    const createCollection = vi.spyOn(store, "createCollection").mockResolvedValue("c9");
    const createFolder = vi.spyOn(store, "createFolder").mockResolvedValue("f9");
    const openFolder = vi.spyOn(store, "openFolder").mockResolvedValue();
    const createInFolder = vi.spyOn(store, "createInFolder").mockResolvedValue();
    const close = vi.spyOn(store, "close").mockResolvedValue();
    const reveal = vi.spyOn(useTreeStore.getState(), "revealInTree");
    const c = ctx();
    useLayoutStore.setState({ sidebarView: "history" });

    action("new-collection").run(c);
    expect(createCollection).toHaveBeenCalled();
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
    action("new-folder").run(c);
    expect(reveal).toHaveBeenCalledWith("c1", { show: true });
    expect(createFolder).toHaveBeenCalledWith("c1");
    action("reveal-request").run(c);
    expect(reveal).toHaveBeenCalledWith("r1", { show: true });
    action("open-workspace").run(c);
    action("create-workspace").run(c);
    action("close-workspace").run(c);
    expect(openFolder).toHaveBeenCalled();
    expect(createInFolder).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();

    action("manage-environments").run(c);
    expect(useLayoutStore.getState().sidebarView).toBe("environments");
    const openGlobals = vi.spyOn(useEnvironmentsStore.getState(), "openGlobals");
    action("edit-globals").run(c);
    expect(openGlobals).toHaveBeenCalled();
  });

  it("run view, settings and secret actions", () => {
    const settings = useSettingsStore.getState();
    const setTheme = vi.spyOn(settings, "setTheme").mockResolvedValue();
    const setLayout = vi.spyOn(settings, "setLayout").mockResolvedValue();
    const c = ctx();

    useThemeStore.setState({ mode: "dark" });
    action("toggle-theme").run(c);
    expect(setTheme).toHaveBeenLastCalledWith("light");
    useThemeStore.setState({ mode: "light" });
    action("toggle-theme").run(c);
    expect(setTheme).toHaveBeenLastCalledWith("dark");

    useLayoutStore.setState({ splitOrientation: "vertical" });
    action("toggle-response-position").run(c);
    expect(setLayout).toHaveBeenLastCalledWith("horizontal");
    useLayoutStore.setState({ splitOrientation: "horizontal" });
    action("toggle-response-position").run(c);
    expect(setLayout).toHaveBeenLastCalledWith("vertical");

    action("open-settings").run(c);
    expect(useSettingsStore.getState().dialogOpen).toBe(true);
    action("settings-secrets").run(c);
    expect(useSettingsStore.getState().section).toBe("secrets");

    const lock = vi.spyOn(useSecretsStore.getState(), "lock").mockResolvedValue();
    action("lock-secrets").run(c);
    expect(lock).toHaveBeenCalled();
    action("unlock-secrets").run(c);
    expect(useSecretsStore.getState().dialog).toBe("unlock");
    action("change-master-password").run(c);
    expect(useSecretsStore.getState().dialog).toBe("change-password");
  });
});
