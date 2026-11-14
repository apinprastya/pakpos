import { toast } from "sonner";
import { api } from "@/lib/api";
import { emptyAuth } from "@/lib/model";
import { col, folder, makeEnv, makeVar } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore, type DocKind } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  docScope,
  loadDocTab,
  openContainerSettings,
  reloadContainerTabs,
  saveDocTab,
  secretRenames,
  syncContainerTabs,
  syncEnvironmentTabs,
  variablesDraft,
} from "./docActions";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tabs = () => useTabsStore.getState();
const tab = (id: string) => tabs().tabs.find((t) => t.id === id);
const open = (kind: DocKind, id: string, name = id) => tabs().openDoc(kind, id, name, "w1");
const bearer = { ...emptyAuth(), type: "bearer" as const, token: "{{t}}" };

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.warning).mockClear();
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    treeLoaded: true,
    collections: [col("c1", "Users", [folder("f1", "Admin")])],
  });
  vi.mocked(api.getEnvironment).mockResolvedValue(makeEnv("e1", "Dev", [makeVar("a", "1")]));
  vi.mocked(api.getCollection).mockResolvedValue({
    id: "c1",
    name: "Users",
    auth: bearer,
    headers: [{ key: "X", value: "1", enabled: true }],
    variables: [makeVar("k", "", { secret: true })],
  });
  vi.mocked(api.getFolder).mockResolvedValue({ id: "f1", name: "Admin", auth: emptyAuth(), headers: [] });
});

describe("doc scopes", () => {
  it("maps tabs to variable scopes", () => {
    expect(docScope({ kind: "environment", targetId: "e" })).toEqual({ kind: "environment", id: "e" });
    expect(docScope({ kind: "globals", targetId: "" })).toEqual({ kind: "global", id: "" });
    expect(docScope({ kind: "collection", targetId: "c" })).toEqual({ kind: "collection", id: "c" });
    expect(docScope({ kind: "folder", targetId: "f" })).toBeNull();
  });
});

describe("loading and saving doc tabs", () => {
  it("loads each kind from Go", async () => {
    const e = open("environment", "e1", "old");
    const g = tabs().openDoc("globals", "", "Globals", "w1");
    const c = open("collection", "c1");
    const f = open("folder", "f1");
    for (const id of [e, g, c, f]) await loadDocTab(id);
    await loadDocTab("missing");
    expect(tab(e)!.doc).toMatchObject({ name: "Dev", draft: { variables: [makeVar("a", "1")] } });
    expect(tab(g)!.doc!.draft).toEqual(variablesDraft([]));
    expect(tab(c)!.doc!.draft).toMatchObject({ auth: bearer, headers: [{ key: "X" }] });
    expect(tab(f)!.doc).toMatchObject({ name: "Admin", draft: { variables: [] } });
  });

  it("saves an environment and reloads the environments", async () => {
    const id = open("environment", "e1");
    await loadDocTab(id);
    tabs().updateDoc(id, (d) => ({ ...d, variables: [...d.variables, makeVar("b", "2"), makeVar("", "")] }));
    const load = vi.spyOn(useEnvironmentsStore.getState(), "load").mockResolvedValue();
    expect(await saveDocTab(id)).toBe(true);
    expect(api.saveVariables).toHaveBeenCalledWith(
      { kind: "environment", id: "e1" },
      [makeVar("a", "1"), makeVar("b", "2")],
      [],
    );
    expect(tab(id)!.doc!.saved!.variables).toHaveLength(2);
    expect(load).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Dev saved");
  });

  it("saves globals, collections and folders, and can close after", async () => {
    const g = tabs().openDoc("globals", "", "Globals", "w1");
    await loadDocTab(g);
    expect(await saveDocTab(g)).toBe(true);
    expect(api.saveGlobals).toHaveBeenCalledWith([], []);

    const touch = vi.spyOn(useEnvironmentsStore.getState(), "touch");
    const c = open("collection", "c1");
    await loadDocTab(c);
    expect(await saveDocTab(c)).toBe(true);
    expect(api.saveCollection).toHaveBeenCalledWith("c1", expect.objectContaining({ auth: bearer }), []);
    expect(touch).toHaveBeenCalled();

    const f = open("folder", "f1");
    await loadDocTab(f);
    expect(await saveDocTab(f, true)).toBe(true);
    expect(api.saveFolder).toHaveBeenCalledWith("f1", { auth: emptyAuth(), headers: [] });
    expect(tab(f)).toBeUndefined();
  });

  it("refuses unloaded or deleted tabs and reports Go errors", async () => {
    const id = open("environment", "e1");
    expect(await saveDocTab(id)).toBe(false);
    expect(await saveDocTab("nope")).toBe(false);
    await loadDocTab(id);
    tabs().patchDoc(id, { missing: true });
    expect(await saveDocTab(id)).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't save Dev", expect.anything());
    tabs().patchDoc(id, { missing: false });
    vi.mocked(api.saveVariables).mockRejectedValueOnce(new Error("read-only"));
    expect(await saveDocTab(id)).toBe(false);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't save Dev", { description: "read-only" });
  });

  it("opens collection and folder settings from the tree", () => {
    openContainerSettings("f1");
    openContainerSettings("nope");
    const docs = tabs()
      .tabs.filter((t) => t.doc)
      .map((t) => t.doc!);
    expect(docs).toEqual([expect.objectContaining({ kind: "folder", targetId: "f1", name: "Admin" })]);
  });
});

describe("keeping doc tabs in step", () => {
  const envs = (list = [makeEnv("e1", "Dev", [makeVar("a", "1")])]) =>
    useEnvironmentsStore.setState({
      status: "ready",
      workspaceId: "w1",
      environments: list,
      globals: { id: "g", variables: [makeVar("g", "disk")] },
    });

  it("follows renames, external edits and deletions of environments", async () => {
    const id = open("environment", "e1");
    await loadDocTab(id);
    const g = tabs().openDoc("globals", "", "Globals", "w1");
    await loadDocTab(g);

    envs([makeEnv("e1", "Development", [makeVar("a", "disk")])]);
    syncEnvironmentTabs();
    expect(tab(id)!.doc).toMatchObject({ name: "Development", draft: { variables: [makeVar("a", "disk")] } });
    expect(tab(g)!.doc!.draft!.variables).toEqual([makeVar("g", "disk")]);

    tabs().updateDoc(id, () => variablesDraft([makeVar("a", "mine")]));
    envs([makeEnv("e1", "Development", [makeVar("a", "disk2")])]);
    syncEnvironmentTabs();
    expect(tab(id)!.doc!.draft!.variables[0].value).toBe("mine");
    expect(toast.info).toHaveBeenCalledWith('"Development" changed on disk', expect.anything());

    envs([]);
    syncEnvironmentTabs();
    syncEnvironmentTabs(); // warned once
    expect(tab(id)!.doc!.missing).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    tabs().updateDoc(id, () => variablesDraft([makeVar("a", "disk2")]));
    tabs().setDocSaved(id, variablesDraft([makeVar("a", "disk2")]));
    syncEnvironmentTabs();
    expect(tab(id)).toBeUndefined(); // clean and gone: closed
  });

  it("waits for the environments of the open workspace", async () => {
    const id = open("environment", "e1");
    await loadDocTab(id);
    useEnvironmentsStore.setState({ status: "loading", workspaceId: "w1", environments: [] });
    syncEnvironmentTabs();
    useEnvironmentsStore.setState({ status: "ready", workspaceId: "other", environments: [] });
    syncEnvironmentTabs();
    expect(tab(id)).toBeDefined();
  });

  it("follows the tree for collection and folder tabs", async () => {
    const c = open("collection", "c1", "Old");
    const f = open("folder", "f1");
    await loadDocTab(f);
    useWorkspaceStore.setState({ treeLoaded: false, collections: [] });
    syncContainerTabs();
    expect(tab(f)).toBeDefined();

    useWorkspaceStore.setState({ treeLoaded: true, collections: [col("c1", "Users")] });
    syncContainerTabs();
    expect(tab(c)!.doc!.name).toBe("Users");
    expect(tab(f)).toBeUndefined();
  });

  it("reloads open collection and folder tabs from disk", async () => {
    const c = open("collection", "c1");
    await loadDocTab(c);
    open("folder", "f1"); // not loaded: skipped
    vi.mocked(api.getCollection).mockResolvedValueOnce({
      id: "c1",
      name: "Users",
      auth: emptyAuth(),
      headers: [],
      variables: [],
    });
    await reloadContainerTabs();
    expect(tab(c)!.doc!.draft!.auth.type).toBe("none");
    vi.mocked(api.getCollection).mockRejectedValueOnce(new Error("gone"));
    await reloadContainerTabs();
    expect(tab(c)).toBeDefined();
  });

  it("does nothing without a workspace", () => {
    open("collection", "c1");
    useWorkspaceStore.setState({ workspace: null, status: "none" });
    syncContainerTabs();
    expect(tabs().tabs).toHaveLength(2);
  });
});

describe("renamed secrets", () => {
  const secret = (key: string, origin?: string) => ({
    ...makeVar(key, "", { secret: true }),
    ...(origin ? { origin } : {}),
  });

  it("pairs each renamed saved secret with its new key", () => {
    const saved = [secret("token"), secret("pw"), makeVar("plain", "1")];
    expect(
      secretRenames(
        [
          secret("apiToken", "token"), // renamed
          secret("pw", "pw"), // edited back
          secret(" ", "pw"), // blank key
          secret("new", "draftOnly"), // never saved
          { ...makeVar("plain2", "1"), origin: "plain" }, // not a secret
          secret("untouched"),
        ],
        saved,
      ),
    ).toEqual([{ from: "token", to: "apiToken" }]);
  });

  it("sends the pairs with the save, and never the editor-only origin", async () => {
    vi.mocked(api.getEnvironment).mockResolvedValue(makeEnv("e1", "Dev", [secret("token")]));
    const id = open("environment", "e1");
    await loadDocTab(id);
    tabs().updateDoc(id, (d) => ({ ...d, variables: [secret("apiToken", "token")] }));
    expect(await saveDocTab(id)).toBe(true);
    expect(api.saveVariables).toHaveBeenCalledWith(
      { kind: "environment", id: "e1" },
      [makeVar("apiToken", "", { secret: true })],
      [{ from: "token", to: "apiToken" }],
    );

    const g = tabs().openDoc("globals", "", "Globals", "w1");
    vi.mocked(api.getGlobals).mockResolvedValue({ id: "g", variables: [secret("a")] });
    await loadDocTab(g);
    tabs().updateDoc(g, (d) => ({ ...d, variables: [secret("b", "a")] }));
    await saveDocTab(g);
    expect(api.saveGlobals).toHaveBeenLastCalledWith(
      [makeVar("b", "", { secret: true })],
      [{ from: "a", to: "b" }],
    );

    vi.mocked(api.getCollection).mockResolvedValue({
      id: "c1",
      name: "Users",
      auth: emptyAuth(),
      headers: [],
      variables: [secret("k")],
    });
    const c = open("collection", "c1");
    await loadDocTab(c);
    tabs().updateDoc(c, (d) => ({ ...d, variables: [secret("k2", "k")] }));
    await saveDocTab(c);
    expect(api.saveCollection).toHaveBeenLastCalledWith("c1", expect.anything(), [{ from: "k", to: "k2" }]);
  });

  it("unlocks before saving a rename, and doesn't save when unlocking is cancelled", async () => {
    vi.mocked(api.getEnvironment).mockResolvedValue(makeEnv("e1", "Dev", [secret("token")]));
    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    const id = open("environment", "e1");
    await loadDocTab(id);
    tabs().updateDoc(id, (d) => ({ ...d, variables: [secret("apiToken", "token")] }));
    const saving = saveDocTab(id);
    await vi.waitFor(() => expect(useSecretsStore.getState().dialog).toBe("unlock"));
    useSecretsStore.getState().closeDialog(false);
    expect(await saving).toBe(false);
    expect(api.saveVariables).not.toHaveBeenCalled();

    // A plain save doesn't need the store.
    tabs().updateDoc(id, (d) => ({ ...d, variables: [secret("token"), makeVar("x", "1")] }));
    expect(await saveDocTab(id)).toBe(true);
  });
});
