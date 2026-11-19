import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { RunEvent, RunProgress } from "@/lib/runModel";
import {
  col,
  folder,
  makeConsoleEntry,
  makeDataPreview,
  makeEnv,
  makeRunListItem,
  makeRunReport,
  makeRunResult,
  makeRunSummary,
  makeTestResult,
  req,
} from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useRunnerStore } from "@/stores/runner";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { RunnerView } from "./RunnerView";
import { RunnerView as LazyRunnerView } from "./lazy";
import { MAX_ROWS } from "./RunResults";

const tabs = () => useTabsStore.getState();
const activeTab = () => tabs().tabs.find((t) => t.id === tabs().activeId)!;

function Active({ lazy = false }: { lazy?: boolean }) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)!);
  return lazy ? <LazyRunnerView tab={tab} /> : <RunnerView tab={tab} />;
}

function openRunner(kind: "collection" | "folder" = "collection", id = "c1", lazy = false) {
  const user = userEvent.setup();
  tabs().openRunner(kind, id, kind === "folder" ? "Users" : "API", "w1");
  render(
    <TooltipProvider>
      <Active lazy={lazy} />
    </TooltipProvider>,
  );
  return user;
}

let emit: (p: RunProgress) => void = () => {};
const send = (e: Partial<RunEvent>, runId = "run-1") =>
  act(() =>
    emit({
      runId,
      workspaceId: "w1",
      event: {
        kind: "started",
        iteration: 0,
        index: 0,
        run: null,
        result: null,
        outcome: "",
        error: "",
        summary: null,
        ...e,
      },
    }),
  );

beforeEach(() => {
  resetTabs();
  useWorkspaceStore.setState({
    status: "ready",
    workspace: { id: "w1", name: "Shop", path: "/shop" },
    treeLoaded: true,
    collections: [
      col("c1", "API", [
        req("r1", "Login", "POST"),
        folder("f1", "Users", [req("r2", "List"), req("r3", "Get")]),
        req("r4", "Logout", "DELETE"),
      ]),
    ],
  });
  useEnvironmentsStore.setState({
    status: "ready",
    workspaceId: "w1",
    environments: [makeEnv("e1", "Dev"), makeEnv("e2", "Prod")],
    selectedId: "e1",
  });
  vi.mocked(api.onRunnerProgress).mockImplementation((cb) => {
    emit = cb;
    return () => {};
  });
});

describe("runner configuration", () => {
  it("lists the requests in run order and selects them", async () => {
    const user = openRunner();
    expect(screen.getByRole("navigation", { name: "Run target" })).toHaveTextContent("API");
    const list = screen.getByRole("region", { name: "Requests" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["Login", "List", "Get", "Logout"]);
    expect(within(list).getAllByText("Users")).toHaveLength(2);
    expect(screen.getByText("4 of 4 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "List" }));
    expect(screen.getByText("3 of 4 selected")).toBeInTheDocument();
    expect(activeTab().doc?.runner?.excludedIds).toEqual(["r2"]);
    await user.click(screen.getByRole("checkbox", { name: "List" }));
    expect(activeTab().doc?.runner?.excludedIds).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 of 4 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run collection" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Run collection" })).toBeEnabled();
  });

  it("runs with the chosen environment, iterations, delay and options", async () => {
    const user = openRunner();
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("Dev");
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(screen.getByRole("option", { name: "Prod" }));

    const iterations = screen.getByRole("textbox", { name: "Iterations" });
    await user.clear(iterations);
    await user.type(iterations, "0");
    expect(iterations).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a whole number from 1 to 10000.")).toBeInTheDocument();
    await user.clear(iterations);
    await user.type(iterations, "3");
    const delay = screen.getByRole("textbox", { name: "Delay between requests (ms)" });
    await user.clear(delay);
    await user.type(delay, "250");
    await user.click(screen.getByRole("checkbox", { name: "Stop at the first failure" }));
    await user.click(screen.getByRole("checkbox", { name: "Keep variable values set by scripts" }));
    await user.click(screen.getByRole("checkbox", { name: "Save responses" }));
    await user.click(screen.getByRole("checkbox", { name: "Record in history" }));
    await user.click(screen.getByRole("checkbox", { name: "Get" }));
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(screen.getByRole("option", { name: "No environment" }));
    expect(activeTab().doc?.runner?.environmentId).toBe("");
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(screen.getByRole("option", { name: "Prod" }));

    await user.click(screen.getByRole("button", { name: "Run collection" }));
    expect(api.startRun).toHaveBeenCalledWith({
      targetId: "c1",
      requestIds: ["r1", "r2", "r4"],
      environmentId: "e2",
      iterations: 3,
      delayMs: 250,
      dataFile: "",
      stopOnFailure: true,
      keepVariables: false,
      saveResponses: true,
      recordHistory: true,
    });
    // The settings survive in the tab.
    expect(activeTab().doc?.runner).toMatchObject({ iterations: 3, delayMs: 250, environmentId: "e2" });
  });

  it("picks a data file and previews it", async () => {
    vi.mocked(api.pickDataFile).mockResolvedValue("/data/users.csv");
    vi.mocked(api.previewData).mockResolvedValue(
      makeDataPreview({
        rows: 7,
        sample: [
          ["ana", "a1"],
          ["bo", "b2"],
        ],
      }),
    );
    const user = openRunner();
    await user.click(screen.getByRole("button", { name: "Choose data file…" }));
    const table = await screen.findByRole("table", { name: "Data file preview" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["user", "pass"]);
    expect(within(table).getByText("bo")).toBeInTheDocument();
    expect(screen.getByText("7 rows")).toBeInTheDocument();
    expect(screen.getByText("First 2 of 7 rows.")).toBeInTheDocument();
    const iterations = screen.getByRole("textbox", { name: "Iterations" });
    expect(iterations).toBeDisabled();
    expect(screen.getByText("One iteration per row of the data file.")).toBeInTheDocument();

    // A file that can't be read says why; removing it brings back iterations.
    vi.mocked(api.pickDataFile).mockResolvedValue("/data/bad.json");
    vi.mocked(api.previewData).mockRejectedValue(new Error('The data file "bad.json" can\'t be used: oops'));
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText(/can't be used: oops/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove data file" }));
    expect(screen.getByRole("textbox", { name: "Iterations" })).toBeEnabled();

    vi.mocked(api.pickDataFile).mockRejectedValue(new Error("dialog failed"));
    await user.click(screen.getByRole("button", { name: "Choose data file…" }));
    expect(await screen.findByText("dialog failed")).toBeInTheDocument();
    vi.mocked(api.pickDataFile).mockResolvedValue("");
    await user.click(screen.getByRole("button", { name: "Choose data file…" }));
    expect(activeTab().doc?.runner?.dataFile).toBe("");

    vi.mocked(api.pickDataFile).mockResolvedValue("/data/users.csv");
    vi.mocked(api.previewData).mockResolvedValue(makeDataPreview());
    await user.click(screen.getByRole("button", { name: "Choose data file…" }));
    await screen.findByText("2 rows");
    await user.click(screen.getByRole("button", { name: "Run collection" }));
    expect(api.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ dataFile: "/data/users.csv", iterations: 0, requestIds: [] }),
    );
  });

  it("runs a folder and explains a target that's gone", async () => {
    openRunner("folder", "f1");
    expect(screen.getByRole("navigation", { name: "Run target" })).toHaveTextContent("APIUsers");
    expect(screen.getAllByRole("checkbox", { name: /List|Get/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Run folder" })).toBeEnabled();
    act(() => useWorkspaceStore.setState({ collections: [] }));
    expect(screen.getByRole("status")).toHaveTextContent("This folder isn't in the open workspace");
  });

  it("explains an empty collection", () => {
    useWorkspaceStore.setState({ collections: [col("c1", "API")] });
    openRunner();
    expect(screen.getByText(/There are no requests here yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run collection" })).toBeDisabled();
  });

  it("loads lazily", async () => {
    openRunner("collection", "c1", true);
    expect(await screen.findByRole("button", { name: "Run collection" })).toBeInTheDocument();
  });
});

describe("live run", () => {
  it("shows progress, results, details and the summary", async () => {
    const user = openRunner();
    await user.click(screen.getByRole("button", { name: "Run collection" }));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the first response…");
    expect(screen.getByRole("button", { name: "Run collection" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Login" })).toBeDisabled();

    const requests = [
      { id: "r1", name: "Login", method: "POST", url: "" },
      { id: "r2", name: "List", method: "GET", url: "" },
    ];
    send({ kind: "started", run: makeRunReport({ requests, iterations: 2, outcome: "running" }) });
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    send({ kind: "requestStarted", iteration: 0, index: 1 });
    expect(screen.getByText("Iteration 1 of 2 · List")).toBeInTheDocument();
    send({
      kind: "requestFinished",
      result: makeRunResult("Login", {
        method: "POST",
        tests: [
          makeTestResult("ok"),
          makeTestResult("is 201", { passed: false, error: "AssertionError: no" }),
        ],
        console: [makeConsoleEntry("hello")],
      }),
    });
    send({
      kind: "requestFinished",
      result: makeRunResult("List", { index: 1, skipped: true, status: 0 }),
    });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuenow", "50");
    const rows = within(screen.getByRole("list", { name: "Run results" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("POSTLogin200 OK12 ms128 B1/2");
    expect(rows[1]).toHaveTextContent("Skipped");
    expect(within(rows[1]).getByRole("button")).toBeDisabled();

    await user.click(within(rows[0]).getByRole("button"));
    expect(screen.getByRole("region", { name: "Tests" })).toHaveTextContent("is 201AssertionError: no");
    expect(screen.getByRole("region", { name: "Console" })).toHaveTextContent("log hello");
    await user.click(screen.getByRole("radio", { name: "Failed 1" }));
    expect(screen.getByRole("list", { name: "Run results" }).children).toHaveLength(1);
    await user.click(screen.getByRole("radio", { name: "All 2" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelRun).toHaveBeenCalledWith("run-1");

    send({
      kind: "finished",
      outcome: "canceled",
      summary: makeRunSummary({
        requests: 2,
        testsPassed: 1,
        testsFailed: 1,
        skipped: 1,
        iterations: 1,
        secretsLocked: true,
      }),
    });
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText(/The secret store was locked/)).toBeInTheDocument();
    expect(screen.getByText("Failed", { selector: "dt" }).nextSibling).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Run collection" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(api.exportRun).toHaveBeenCalledWith("run-1", "json");
    await user.click(screen.getByRole("button", { name: "Export HTML" }));
    expect(api.exportRun).toHaveBeenCalledWith("run-1", "html");
    vi.mocked(api.startRun).mockResolvedValue("run-2");
    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(api.startRun).toHaveBeenCalledTimes(2);
  });

  it("shows saved responses, errors and the run's error", async () => {
    const user = openRunner();
    act(() => {
      useRunnerStore.setState({
        shown: { c1: "old" },
        runs: {
          old: {
            done: true,
            current: null,
            report: makeRunReport({
              id: "old",
              outcome: "error",
              error: "setNextRequest jumped more than 1000 times",
              environmentName: "Dev",
              dataFile: "users.csv",
              iterations: 2,
              summary: makeRunSummary({ iterations: 2, requests: 3 }),
              results: [
                makeRunResult("Login", {
                  response: { contentType: "", headers: [], body: '{"a":1}', truncated: true, omitted: "" },
                }),
                makeRunResult("Img", {
                  iteration: 1,
                  response: { contentType: "", headers: [], body: "", truncated: false, omitted: "binary" },
                }),
                makeRunResult("More", {
                  iteration: 1,
                  response: { contentType: "", headers: [], body: "", truncated: false, omitted: "limit" },
                }),
                makeRunResult("Down", { status: 0, error: { kind: "dns", message: "No such host" } }),
              ],
            }),
          },
        },
      });
    });
    expect(screen.getByText("Stopped with an error")).toBeInTheDocument();
    expect(screen.getByText(/Environment Dev · 2 iterations · users.csv/)).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Run results" })).getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("#2");
    await user.click(within(rows[0]).getByRole("button"));
    expect(screen.getByRole("region", { name: "Response body" })).toHaveTextContent('{"a":1}Cut at 1 MB.');
    await user.click(within(rows[0]).getByRole("button"));
    await user.click(within(rows[1]).getByRole("button"));
    expect(screen.getByText("Binary body not saved.")).toBeInTheDocument();
    await user.click(within(rows[2]).getByRole("button"));
    expect(screen.getByText(/reached their limit/)).toBeInTheDocument();
    await user.click(within(rows[3]).getByRole("button"));
    expect(within(rows[3]).getAllByText("No such host")).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "Failed 1" }));
    act(() =>
      useRunnerStore.setState((s) => ({
        runs: { old: { ...s.runs.old, report: { ...s.runs.old.report, results: [makeRunResult("A")] } } },
      })),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Nothing failed.");
  });

  it("caps the rows it renders", () => {
    openRunner();
    const results = Array.from({ length: MAX_ROWS + 1 }, (_, i) => makeRunResult(`R${i}`));
    act(() =>
      useRunnerStore.setState({
        shown: { c1: "big" },
        runs: { big: { done: true, current: null, report: makeRunReport({ id: "big", results }) } },
      }),
    );
    expect(within(screen.getByRole("list", { name: "Run results" })).getAllByRole("listitem")).toHaveLength(
      MAX_ROWS,
    );
    expect(
      screen.getByText(`Showing the first ${MAX_ROWS} of ${MAX_ROWS + 1} results.`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows an empty finished run", () => {
    openRunner();
    act(() =>
      useRunnerStore.setState({
        shown: { c1: "e" },
        runs: { e: { done: true, current: null, report: makeRunReport({ id: "e" }) } },
      }),
    );
    expect(screen.getByText("Passed", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No requests ran.");
  });
});

describe("past runs", () => {
  it("lists the target's runs, opens and deletes them", async () => {
    vi.mocked(api.listRuns).mockResolvedValue([
      makeRunListItem("a", {
        dataFile: "users.csv",
        iterations: 2,
        totals: { requests: 4, errors: 1, skipped: 0, testsPassed: 3, testsFailed: 1 },
        outcome: "failed",
      }),
      makeRunListItem("b", { environmentName: "" }),
      makeRunListItem("other", { target: { id: "c9", kind: "collection", name: "Other", path: [] } }),
    ]);
    vi.mocked(api.getRun).mockResolvedValue(makeRunReport({ id: "a", outcome: "failed" }));
    const user = openRunner();
    await user.click(await screen.findByRole("tab", { name: "Past runs (2)" }));
    const list = screen.getByRole("list", { name: "Past runs" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Failed");
    expect(items[0]).toHaveTextContent("Dev · 2 iterations · users.csv");
    expect(items[0]).toHaveTextContent("4 requests · 3 passed · 1 failed · 1 errors");
    expect(items[1]).toHaveTextContent("No environment · 1 iteration");

    await user.click(within(items[0]).getAllByRole("button")[0]);
    expect(api.getRun).toHaveBeenCalledWith("a");
    expect(await screen.findByText("Finished with failures")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Results" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Past runs (2)" }));
    expect(
      within(screen.getByRole("list", { name: "Past runs" }))
        .getAllByRole("listitem")[0]
        .querySelector("[aria-current]"),
    ).not.toBeNull();
    await user.click(screen.getAllByRole("button", { name: /^Delete the run of/ })[1]);
    expect(api.deleteRun).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Past runs (1)" })).toBeInTheDocument());
  });

  it("explains an empty list and a failed load", async () => {
    const user = openRunner();
    await user.click(screen.getByRole("tab", { name: "Past runs" }));
    expect(await screen.findByText(/No past runs yet/)).toBeInTheDocument();
    vi.mocked(api.listRuns).mockRejectedValue(new Error("db closed"));
    await act(() => useRunnerStore.getState().loadPast());
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load past runs: db closed");
    vi.mocked(api.listRuns).mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No past runs yet/)).toBeInTheDocument();
    act(() => useRunnerStore.setState({ pastStatus: "loading" }));
    expect(screen.getByText("Loading past runs…")).toBeInTheDocument();
  });
});
