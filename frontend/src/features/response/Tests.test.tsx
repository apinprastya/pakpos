import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SendResult } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { makeResponse, makeResult, makeScriptSource, makeTestResult } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { ResponsePane } from "./ResponsePane";
import { testCounts } from "./tests";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function show(result: SendResult) {
  resetTabs({ url: "https://x" }, { result, sections: { response: "tests" } });
  return render(
    <TooltipProvider>
      <ResponsePane />
    </TooltipProvider>,
  );
}

const tests = [
  makeTestResult("Status is 200"),
  makeTestResult("Has an id", {
    source: makeScriptSource({ kind: "collection", id: "c1", name: "Users", event: "test" }),
  }),
  makeTestResult("Is admin", { passed: false, error: "AssertionError: expected false to be true" }),
  makeTestResult("Later", { passed: false, skipped: true }),
];

describe("Tests tab", () => {
  it("counts passed tests in the label, coloured by the outcome", () => {
    const { unmount } = show(makeResult({ response: makeResponse(), tests }));
    const tab = screen.getByRole("tab", { name: /^Tests/ });
    expect(tab).toHaveTextContent("Tests 2/3");
    expect(within(tab).getByText("2/3")).toHaveClass("text-status-client");
    unmount();
    show(makeResult({ response: makeResponse(), tests: [tests[0]] }));
    expect(within(screen.getByRole("tab", { name: /^Tests/ })).getByText("1/1")).toHaveClass(
      "text-status-ok",
    );
  });

  it("lists tests with their state and error, and filters them", async () => {
    const user = userEvent.setup();
    show(makeResult({ response: makeResponse(), tests }));
    const list = screen.getByRole("list", { name: "Test results" });
    expect(within(list).getAllByLabelText("Passed")).toHaveLength(2);
    expect(within(list).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(list).getByLabelText("Skipped")).toBeInTheDocument();
    expect(within(list).getByText("AssertionError: expected false to be true")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Failed 1" }));
    expect(screen.getByRole("button", { name: "Failed 1" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Passed 2" }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "All 4" }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(4);
  });

  it("says when a filter has nothing", async () => {
    const user = userEvent.setup();
    const { unmount } = show(makeResult({ response: makeResponse(), tests: [tests[0]] }));
    await user.click(screen.getByRole("button", { name: "Failed 0" }));
    expect(screen.getByText("No test failed.")).toBeInTheDocument();
    unmount();
    show(makeResult({ response: makeResponse(), tests: [tests[2]] }));
    await user.click(screen.getByRole("button", { name: "Passed 0" }));
    expect(screen.getByText("No test passed.")).toBeInTheDocument();
  });

  it("opens the script a test came from", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ workspace: { id: "w1", name: "W", path: "/w" } });
    show(makeResult({ response: makeResponse(), tests }));
    await user.click(screen.getAllByRole("button", { name: "test script" })[0]);
    expect(activeTab().sections).toMatchObject({ request: "scripts", scripts: "test" });

    await user.click(screen.getByRole("button", { name: "test script of collection Users" }));
    const doc = activeTab();
    expect(doc.doc).toMatchObject({ kind: "collection", targetId: "c1" });
    expect(doc.sections).toMatchObject({ settings: "scripts", scripts: "test" });
  });

  it("points to the Scripts tab when the request has no tests", async () => {
    const user = userEvent.setup();
    show(makeResult({ response: makeResponse() }));
    expect(screen.getByRole("tab", { name: /^Tests/ })).toHaveTextContent(/^Tests$/);
    expect(screen.getByText("No tests ran for this request.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open tests" }));
    expect(activeTab().sections).toMatchObject({ request: "scripts", scripts: "test" });
  });

  it("counts helper", () => {
    expect(testCounts(tests)).toEqual({ passed: 2, total: 3, failed: 1 });
  });
});

describe("script outcomes in the response pane", () => {
  it("shows a skipped send instead of a response", async () => {
    const user = userEvent.setup();
    show(makeResult({ skipped: true }));
    expect(
      screen.getByText("Skipped by a pre-request script (pm.execution.skipRequest)"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open pre-request script" }));
    expect(activeTab().sections).toMatchObject({ request: "scripts", scripts: "prerequest" });
  });

  it("shows a script error with a way to open that script", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ workspace: { id: "w1", name: "W", path: "/w" } });
    const message =
      'Error in the pre-request script of folder "Auth" at line 3:5: ReferenceError: x is not defined';
    show(
      makeResult({
        error: { kind: "script", message },
        historyId: 3,
        scriptError: {
          source: makeScriptSource({ kind: "folder", id: "f1", name: "Auth" }),
          line: 3,
          column: 5,
        },
      }),
    );
    expect(screen.getByText("A pre-request script failed")).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open the pre-request script of folder Auth" }));
    expect(activeTab().doc).toMatchObject({ kind: "folder", targetId: "f1" });
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });

  it("opens the Auth tab from an auth error", async () => {
    const user = userEvent.setup();
    show(
      makeResult({ error: { kind: "auth", message: "The auth couldn't be applied. Check the Auth tab." } }),
    );
    await user.click(screen.getByRole("button", { name: "Open the Auth tab" }));
    expect(activeTab().sections).toMatchObject({ request: "auth" });
  });

  it("opens the request's own script from its error", async () => {
    const user = userEvent.setup();
    show(
      makeResult({
        error: { kind: "script", message: "Error" },
        scriptError: { source: makeScriptSource(), line: 1, column: 1 },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Open the pre-request script" }));
    expect(activeTab().sections).toMatchObject({ request: "scripts", scripts: "prerequest" });
  });
});
