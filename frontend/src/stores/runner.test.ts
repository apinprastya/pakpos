import { toast } from "sonner";
import { api } from "@/lib/api";
import type { RunConfig, RunEvent, RunProgress } from "@/lib/runModel";
import {
  makeConsoleEntry,
  makeRunListItem,
  makeRunReport,
  makeRunResult,
  makeRunSummary,
} from "@/test/fixtures";
import { useConsoleStore } from "./console";
import { resultStatus, useRunnerStore } from "./runner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const s = () => useRunnerStore.getState();

const config: RunConfig = {
  targetId: "c1",
  requestIds: [],
  environmentId: "e1",
  iterations: 2,
  delayMs: 0,
  dataFile: "",
  stopOnFailure: true,
  keepVariables: true,
  saveResponses: false,
  recordHistory: false,
};

function event(patch: Partial<RunEvent>): RunEvent {
  return {
    kind: "started",
    iteration: 0,
    index: 0,
    run: null,
    result: null,
    outcome: "",
    error: "",
    summary: null,
    ...patch,
  };
}

const progress = (e: Partial<RunEvent>, runId = "run-1"): RunProgress => ({
  runId,
  workspaceId: "ws1",
  event: event(e),
});

describe("runner store", () => {
  it("starts a run, follows its events and adds the console per request and iteration", async () => {
    let listener: ((p: RunProgress) => void) | undefined;
    vi.mocked(api.onRunnerProgress).mockImplementation((cb) => {
      listener = cb;
      return () => {};
    });
    const pending = s().start("c1", config);
    expect(s().starting.c1).toBe(true);
    expect(await pending).toBe("run-1");
    expect(api.startRun).toHaveBeenCalledWith(config);
    expect(s().starting.c1).toBe(false);
    expect(s().shown.c1).toBe("run-1");
    // A placeholder until "started" arrives.
    expect(s().runs["run-1"].report.options.stopOnFailure).toBe(true);
    expect(s().runs["run-1"].report.iterations).toBe(2);

    const report = makeRunReport({
      requests: [{ id: "r1", name: "Login", method: "POST", url: "" }],
      iterations: 2,
      outcome: "running",
    });
    listener!(progress({ kind: "started", run: report }));
    expect(s().runs["run-1"].report.requests).toHaveLength(1);
    listener!(progress({ kind: "requestStarted", iteration: 1, index: 0 }));
    expect(s().runs["run-1"].current).toEqual({ iteration: 1, index: 0 });

    const result = makeRunResult("Login", {
      iteration: 1,
      method: "POST",
      console: [makeConsoleEntry("token [secret:token]")],
    });
    listener!(progress({ kind: "requestFinished", iteration: 1, result }));
    expect(s().runs["run-1"].report.results).toEqual([result]);
    const group = useConsoleStore.getState().groups[0];
    expect(group).toMatchObject({
      method: "POST",
      name: "Login",
      status: "200 OK",
      context: "Run API · Iteration 2",
      done: true,
    });
    expect(group.lines.map((l) => l.text)).toEqual(["token [secret:token]"]);

    // A script error is a console line too; a result without console adds no group.
    listener!(
      progress({
        kind: "requestFinished",
        result: makeRunResult("Me", { error: { kind: "script", message: "boom" }, status: 0 }),
      }),
    );
    listener!(progress({ kind: "requestFinished", result: makeRunResult("Quiet") }));
    expect(useConsoleStore.getState().groups.map((g) => g.lines.map((l) => l.text))).toEqual([
      ["token [secret:token]"],
      ["boom"],
    ]);
    listener!(progress({ kind: "iterationFinished" }));

    vi.mocked(api.listRuns).mockResolvedValue([makeRunListItem("run-1")]);
    listener!(
      progress({ kind: "finished", outcome: "failed", error: "", summary: makeRunSummary({ requests: 3 }) }),
    );
    const done = s().runs["run-1"];
    expect(done.done).toBe(true);
    expect(done.current).toBeNull();
    expect(done.report.outcome).toBe("failed");
    expect(done.report.summary.requests).toBe(3);
    await vi.waitFor(() => expect(s().past).toHaveLength(1));

    // Events for runs the store doesn't know are ignored.
    listener!(progress({ kind: "requestStarted" }, "other"));
    listener!(progress({ kind: "requestFinished", result: makeRunResult("x") }, "other"));
    listener!(progress({ kind: "finished" }, "other"));
    listener!(progress({ kind: "started" }, "other"));
    expect(s().runs.other).toBeUndefined();
  });

  it("keeps results that arrived before start resolved, and a finish without a summary", () => {
    s().handle(progress({ kind: "started", run: makeRunReport({ outcome: "running" }) }));
    s().handle(progress({ kind: "requestFinished", result: makeRunResult("A") }));
    s().handle(progress({ kind: "started", run: makeRunReport({ outcome: "running" }) }));
    expect(s().runs["run-1"].report.results).toHaveLength(1);
    s().handle(progress({ kind: "finished" }));
    expect(s().runs["run-1"].report.outcome).toBe("passed");
  });

  it("reports a run that can't start", async () => {
    vi.mocked(api.startRun).mockRejectedValue(new Error("The data file has no rows."));
    expect(await s().start("c1", config)).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Couldn't start the run", {
      description: "The data file has no rows.",
    });
    expect(s().starting.c1).toBe(false);
  });

  it("cancels, and reports a failed cancel", async () => {
    await s().cancel("run-1");
    expect(api.cancelRun).toHaveBeenCalledWith("run-1");
    vi.mocked(api.cancelRun).mockRejectedValue(new Error("gone"));
    await s().cancel("run-1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't cancel the run", { description: "gone" });
  });

  it("opens past runs from memory or Go", async () => {
    vi.mocked(api.getRun).mockResolvedValue(makeRunReport({ id: "old" }));
    await s().openPast("c1", "old");
    expect(s().shown.c1).toBe("old");
    expect(s().runs.old.done).toBe(true);
    await s().openPast("c2", "old");
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(s().shown.c2).toBe("old");
    vi.mocked(api.getRun).mockRejectedValue(new Error("This run is no longer stored."));
    await s().openPast("c1", "gone");
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the run", {
      description: "This run is no longer stored.",
    });
    s().show("c1", null);
    expect(s().shown.c1).toBeNull();
  });

  it("loads, deletes and exports past runs", async () => {
    vi.mocked(api.listRuns).mockResolvedValue([makeRunListItem("a"), makeRunListItem("b")]);
    await s().loadPast();
    expect(s().pastStatus).toBe("ready");
    vi.mocked(api.getRun).mockResolvedValue(makeRunReport({ id: "a" }));
    await s().openPast("c1", "a");
    await s().removePast("a");
    expect(s().past.map((r) => r.id)).toEqual(["b"]);
    expect(s().shown.c1).toBeNull();
    expect(s().runs.a).toBeUndefined();

    vi.mocked(api.deleteRun).mockRejectedValue(new Error("db"));
    await s().removePast("b");
    expect(s().past).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete the run", { description: "db" });

    vi.mocked(api.listRuns).mockRejectedValue(new Error("No workspace"));
    await s().loadPast();
    expect(s().pastStatus).toBe("error");
    expect(s().pastError).toBe("No workspace");

    vi.mocked(api.exportRun).mockResolvedValue("/tmp/report.html");
    await s().exportRun("b", "html");
    expect(api.exportRun).toHaveBeenCalledWith("b", "html");
    expect(toast.success).toHaveBeenCalledWith("Report saved", { description: "/tmp/report.html" });
    vi.mocked(toast.success).mockClear();
    vi.mocked(api.exportRun).mockResolvedValue("");
    await s().exportRun("b", "json");
    expect(toast.success).not.toHaveBeenCalled();
    vi.mocked(api.exportRun).mockRejectedValue(new Error("disk full"));
    await s().exportRun("b", "json");
    expect(toast.error).toHaveBeenCalledWith("Couldn't export the report", { description: "disk full" });
  });

  it("describes a result's status", () => {
    expect(resultStatus(makeRunResult("a"))).toBe("200 OK");
    expect(resultStatus(makeRunResult("a", { skipped: true }))).toBe("Skipped");
    expect(resultStatus(makeRunResult("a", { error: { kind: "dns", message: "No such host" } }))).toBe(
      "No such host",
    );
  });
});
