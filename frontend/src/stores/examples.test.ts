import { toast } from "sonner";
import { api } from "@/lib/api";
import { useExamplesStore } from "@/stores/examples";
import { useSecretsStore } from "@/stores/secrets";
import { useWorkspaceStore } from "@/stores/workspace";
import { makeExample, makeExampleSummary, savedExample, makeResponse, makeResult } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { emptyRequest } from "@/lib/model";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const ws = { id: "w1", name: "Shop", path: "/shop" };
const s = () => useExamplesStore.getState();

beforeEach(() => {
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("examples store", () => {
  it("loads examples grouped by request and clears without a workspace", async () => {
    vi.mocked(api.listAllExamples).mockResolvedValue([
      makeExampleSummary("x1", "r1"),
      makeExampleSummary("x2", "r1", { name: "Empty" }),
      makeExampleSummary("x3", "r2"),
    ]);
    await s().load();
    expect(s().workspaceId).toBe("w1");
    expect(s().byRequest.r1.map((e) => e.id)).toEqual(["x1", "x2"]);
    expect(s().byRequest.r2).toHaveLength(1);

    useWorkspaceStore.setState({ workspace: null });
    await s().load();
    expect(s()).toMatchObject({ workspaceId: null, byRequest: {}, viewing: {} });
  });

  it("keeps the cache when loading fails and ignores stale loads", async () => {
    vi.mocked(api.listAllExamples).mockResolvedValue([makeExampleSummary("x1", "r1")]);
    await s().load();
    vi.mocked(api.listAllExamples).mockRejectedValue(new Error("boom"));
    await s().load();
    expect(s().byRequest.r1).toHaveLength(1);

    let release!: (v: never[]) => void;
    vi.mocked(api.listAllExamples).mockImplementationOnce(() => new Promise((r) => (release = r)));
    const slow = s().load();
    vi.mocked(api.listAllExamples).mockResolvedValueOnce([]);
    await s().load();
    release([]);
    await slow;
    expect(s().byRequest).toEqual({});
  });

  it("shows and hides an example per tab; a reload drops deleted ones", async () => {
    vi.mocked(api.getExample).mockResolvedValue(makeExample("x1"));
    expect(await s().show("t1", "r1", "x1")).toBe(true);
    expect(api.getExample).toHaveBeenCalledWith("r1", "x1");
    expect(s().viewing.t1.id).toBe("x1");
    s().hide("t2"); // nothing shown there
    s().hide("t1");
    expect(s().viewing.t1).toBeUndefined();

    await s().show("t1", "r1", "x1");
    vi.mocked(api.listAllExamples).mockResolvedValue([]);
    await s().load();
    expect(s().viewing.t1).toBeUndefined();

    vi.mocked(api.getExample).mockRejectedValue(new Error("gone"));
    expect(await s().show("t1", "r1", "x1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the example", { description: "gone" });
  });

  it("saves the tab's response as an example of its saved request", async () => {
    const saved = { ...emptyRequest(), id: "r1", name: "List" };
    resetTabs(saved, { saved, result: makeResult({ response: makeResponse(), historyId: 9 }) });
    vi.mocked(api.saveExample).mockResolvedValue(
      savedExample(makeExampleSummary("x1", "r1", { name: "Mine" })),
    );
    vi.mocked(api.listAllExamples).mockResolvedValue([makeExampleSummary("x1", "r1", { name: "Mine" })]);
    expect(await s().save("t1", "Mine")).toEqual({ status: "saved" });
    expect(api.saveExample).toHaveBeenCalledWith("r1", "Mine", 9, false);
    expect(toast.success).toHaveBeenCalledWith("Example saved", { description: "Mine" });
    expect(s().byRequest.r1).toHaveLength(1);

    vi.mocked(api.saveExample).mockRejectedValue(
      new Error("Response bodies over 1 MB can't be saved as examples."),
    );
    expect(await s().save("t1", "Big")).toEqual({ status: "failed" });
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the example", {
      description: "Response bodies over 1 MB can't be saved as examples.",
    });

    resetTabs({}, { result: makeResult({ response: makeResponse(), historyId: 9 }) });
    vi.mocked(api.saveExample).mockClear();
    expect(await s().save("t1", "x")).toEqual({ status: "failed" });
    expect(await s().save("nope", "x")).toEqual({ status: "failed" });
    expect(api.saveExample).not.toHaveBeenCalled();
  });

  it("renames (also the example being shown) and deletes", async () => {
    vi.mocked(api.listAllExamples).mockResolvedValue([makeExampleSummary("x1", "r1", { name: "Old" })]);
    await s().load();
    vi.mocked(api.getExample).mockResolvedValue(makeExample("x1", { name: "Old" }));
    await s().show("t1", "r1", "x1");
    await s().show("t2", "r9", "x9");
    vi.mocked(api.renameExample).mockResolvedValue(makeExampleSummary("x1", "r1", { name: "New" }));
    await s().rename("r1", "x1", "  New ");
    expect(api.renameExample).toHaveBeenCalledWith("r1", "x1", "New");
    expect(s().viewing.t1.name).toBe("New");

    vi.mocked(api.renameExample).mockClear();
    await s().rename("r1", "x1", "Old"); // same name as cached
    await s().rename("r1", "x1", " ");
    await s().rename("r1", "nope", "x");
    expect(api.renameExample).not.toHaveBeenCalled();

    vi.mocked(api.renameExample).mockRejectedValue(new Error("disk full"));
    await s().rename("r1", "x1", "Other");
    expect(toast.error).toHaveBeenCalledWith("Couldn't rename the example", { description: "disk full" });

    await s().remove("r1", "x1");
    expect(api.deleteExample).toHaveBeenCalledWith("r1", "x1");
    expect(toast.success).toHaveBeenCalledWith("Example deleted");
    vi.mocked(api.deleteExample).mockRejectedValue(new Error("nope"));
    await s().remove("r1", "x1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the example", { description: "nope" });
  });
});

describe("examples store: secret values", () => {
  const saved = { ...emptyRequest(), id: "r1", name: "List" };
  beforeEach(() =>
    resetTabs(saved, { saved, result: makeResult({ response: makeResponse(), historyId: 9 }) }),
  );
  const found = (names: string[]) => ({ example: null, secretsFound: names, secretsLocked: false });
  const locked = { example: null, secretsFound: [], secretsLocked: true };

  it("reports secrets found and saves with replacement when asked", async () => {
    vi.mocked(api.saveExample).mockResolvedValueOnce(found(["token", "apiKey"]));
    expect(await s().save("t1", "Echo")).toEqual({ status: "secrets", names: ["token", "apiKey"] });
    vi.mocked(api.saveExample).mockResolvedValueOnce(savedExample(makeExampleSummary("x1", "r1")));
    expect(await s().save("t1", "Echo", true)).toEqual({ status: "saved" });
    expect(api.saveExample).toHaveBeenLastCalledWith("r1", "Echo", 9, true);
  });

  it("unlocks the secret store before checking, and doesn't save if the user cancels", async () => {
    const ensure = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValueOnce(true);
    vi.mocked(api.saveExample)
      .mockResolvedValueOnce(locked)
      .mockResolvedValueOnce(savedExample(makeExampleSummary("x1", "r1")));
    expect(await s().save("t1", "Echo")).toEqual({ status: "saved" });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(api.saveExample).toHaveBeenCalledTimes(2);

    ensure.mockResolvedValueOnce(false);
    vi.mocked(api.saveExample).mockResolvedValueOnce(locked);
    expect(await s().save("t1", "Echo")).toEqual({ status: "failed" });
    expect(toast.info).toHaveBeenCalledWith("The example wasn't saved", expect.anything());

    ensure.mockResolvedValueOnce(true);
    vi.mocked(api.saveExample).mockResolvedValueOnce(locked).mockResolvedValueOnce(locked);
    expect(await s().save("t1", "Echo")).toEqual({ status: "failed" });
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the example", {
      description: "The secrets are still locked. Unlock them and try again.",
    });
  });
});
