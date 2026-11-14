import { toast } from "sonner";
import { api } from "@/lib/api";
import { makeEnv, makeVar } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { moveId, shiftId, useEnvironmentsStore } from "./environments";
import { useTabsStore } from "./tabs";
import { useWorkspaceStore } from "./workspace";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const store = () => useEnvironmentsStore.getState();
const dev = makeEnv("e1", "Dev", [makeVar("baseUrl", "https://dev")]);
const prod = makeEnv("e2", "Prod");

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.error).mockClear();
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  vi.mocked(api.listEnvironments).mockResolvedValue([dev, prod]);
  vi.mocked(api.getGlobals).mockResolvedValue({ id: "g", variables: [makeVar("a", "1")] });
  vi.mocked(api.selectedEnvironment).mockResolvedValue({ id: "e2", name: "Prod" });
});

describe("environments store", () => {
  it("loads environments, globals and the selection of the open workspace", async () => {
    await store().load();
    expect(store()).toMatchObject({ status: "ready", workspaceId: "w1", selectedId: "e2", error: null });
    expect(store().environments.map((e) => e.name)).toEqual(["Dev", "Prod"]);
    expect(store().globals?.variables).toHaveLength(1);
    expect(store().version).toBeGreaterThan(0);
  });

  it("clears without a workspace and reports load errors", async () => {
    await store().load();
    useWorkspaceStore.setState({ workspace: null });
    await store().load();
    expect(store()).toMatchObject({ status: "idle", workspaceId: null, environments: [], selectedId: "" });

    useWorkspaceStore.setState({ workspace: ws });
    vi.mocked(api.listEnvironments).mockRejectedValue(new Error("boom"));
    await store().load();
    expect(store()).toMatchObject({ status: "error", error: "boom" });
  });

  it("ignores a load that finished after a newer one", async () => {
    let resolveFirst: (v: (typeof dev)[]) => void = () => {};
    vi.mocked(api.listEnvironments).mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    const first = store().load();
    await store().load();
    resolveFirst([makeEnv("old")]);
    await first;
    expect(store().environments.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("selects an environment and rolls back when Go refuses", async () => {
    await store().load();
    await store().select("e1");
    expect(api.selectEnvironment).toHaveBeenCalledWith("e1");
    expect(store().selectedId).toBe("e1");
    await store().select("e1");
    expect(api.selectEnvironment).toHaveBeenCalledTimes(1);

    vi.mocked(api.selectEnvironment).mockRejectedValueOnce(new Error("gone"));
    await store().select("");
    expect(store().selectedId).toBe("e1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't switch the environment", { description: "gone" });
  });

  it("creates, renames and duplicates, starting new ones in rename mode", async () => {
    vi.mocked(api.createEnvironment).mockResolvedValue(makeEnv("e3", "New environment"));
    expect((await store().create())?.id).toBe("e3");
    expect(api.createEnvironment).toHaveBeenCalledWith("New environment");
    expect(store().renameTarget).toBe("e3");
    store().setRenameTarget(null);

    await store().rename("e1", "  Development ");
    expect(api.renameEnvironment).toHaveBeenCalledWith("e1", "Development");
    await store().rename("e1", "Dev"); // unchanged
    await store().rename("e1", " ");
    await store().rename("nope", "X");
    expect(api.renameEnvironment).toHaveBeenCalledTimes(1);

    vi.mocked(api.duplicateEnvironment).mockResolvedValue(makeEnv("e4", "Dev copy"));
    expect((await store().duplicate("e1"))?.id).toBe("e4");
    expect(store().renameTarget).toBe("e4");
  });

  it("reports failures of create, rename, duplicate, delete and reorder", async () => {
    await store().load();
    const err = new Error("disk full");
    vi.mocked(api.createEnvironment).mockRejectedValue(err);
    vi.mocked(api.renameEnvironment).mockRejectedValue(err);
    vi.mocked(api.duplicateEnvironment).mockRejectedValue(err);
    vi.mocked(api.deleteEnvironment).mockRejectedValue(err);
    vi.mocked(api.reorderEnvironments).mockRejectedValue(err);
    expect(await store().create()).toBeNull();
    await store().rename("e1", "X");
    expect(await store().duplicate("e1")).toBeNull();
    await store().remove("e1");
    await store().reorder(["e2", "e1"]);
    const titles = vi.mocked(toast.error).mock.calls.map((c) => c[0]);
    expect(titles).toEqual([
      "Couldn't create the environment",
      "Couldn't rename the environment",
      "Couldn't duplicate the environment",
      "Couldn't delete the environment",
      "Couldn't reorder environments",
    ]);
  });

  it("deletes an environment and closes its tab", async () => {
    await store().load();
    store().open("e1");
    expect(useTabsStore.getState().tabs.some((t) => t.doc?.targetId === "e1")).toBe(true);
    await store().remove("e1");
    expect(api.deleteEnvironment).toHaveBeenCalledWith("e1");
    expect(useTabsStore.getState().tabs.some((t) => t.doc?.targetId === "e1")).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Environment deleted");
  });

  it("reorders optimistically", async () => {
    await store().load();
    let release: () => void = () => {};
    vi.mocked(api.reorderEnvironments).mockReturnValueOnce(new Promise((r) => (release = () => r())));
    const done = store().reorder(["e2", "e1"]);
    expect(store().environments.map((e) => e.id)).toEqual(["e2", "e1"]);
    release();
    await done;
    expect(api.reorderEnvironments).toHaveBeenCalledWith(["e2", "e1"]);
  });

  it("opens environment and globals tabs in the open workspace", async () => {
    await store().load();
    store().open("missing");
    store().open("e1");
    store().openGlobals();
    const docs = useTabsStore.getState().tabs.filter((t) => t.doc);
    expect(docs.map((t) => [t.doc!.kind, t.doc!.name, t.workspaceId])).toEqual([
      ["environment", "Dev", "w1"],
      ["globals", "Globals", "w1"],
    ]);
  });

  it("bumps the version on touch", () => {
    const v = store().version;
    store().touch();
    expect(store().version).toBe(v + 1);
  });
});

describe("reorder helpers", () => {
  it("shifts an id by one place", () => {
    expect(shiftId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(shiftId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(shiftId(["a", "b"], "a", -1)).toBeNull();
    expect(shiftId(["a", "b"], "b", 1)).toBeNull();
    expect(shiftId(["a"], "x", 1)).toBeNull();
  });

  it("moves an id onto another", () => {
    expect(moveId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveId(["a", "b"], "a", "a")).toBeNull();
    expect(moveId(["a", "b"], "x", "a")).toBeNull();
  });
});
