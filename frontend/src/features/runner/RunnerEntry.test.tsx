import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { syncContainerTabs } from "@/features/scopes/docActions";
import { api } from "@/lib/api";
import type { CollectionNode } from "@/lib/model";
import { usePaletteStore } from "@/stores/palette";
import { useRunnerStore } from "@/stores/runner";
import { defaultRunnerSettings, tabTitle, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { useConsoleStore } from "@/stores/console";
import { ConsoleDrawer } from "@/features/console/ConsoleDrawer";
import { col, folder, makeConsoleEntry, makeRunListItem, makeRunReport, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { containerPath, openRunnerFor, runOrder, toRunConfig } from "./open";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } };
});

const tree = (): CollectionNode[] => [
  col("c1", "API", [
    folder("f1", "Users", [req("r1", "List"), folder("f2", "Deep", [req("r2", "Get")])]),
    req("r3", "Out"),
  ]),
  col("c2", "Orders", [folder("f3", "Refunds", [req("r4", "Refund")])]),
];

beforeEach(() => {
  resetTabs();
  useWorkspaceStore.setState({
    status: "ready",
    workspace: { id: "w1", name: "Shop", path: "/shop" },
    collections: tree(),
    treeLoaded: true,
  });
});

describe("run order and config", () => {
  it("walks folders depth-first and builds the config", () => {
    const order = runOrder(tree()[0]);
    expect(order.map((o) => `${o.folders.join("/")}:${o.request.name}`)).toEqual([
      "Users:List",
      "Users/Deep:Get",
      ":Out",
    ]);
    expect(containerPath(tree(), "f2")).toEqual(["API", "Users", "Deep"]);
    expect(containerPath(tree(), "nope")).toEqual([]);
    const settings = { ...defaultRunnerSettings("collection"), excludedIds: ["r2"], iterations: 4 };
    expect(toRunConfig("c1", order, settings, "e1")).toMatchObject({
      requestIds: ["r1", "r3"],
      environmentId: "e1",
      iterations: 4,
    });
    expect(toRunConfig("c1", order, { ...settings, excludedIds: [], environmentId: "" }, "e1")).toMatchObject(
      {
        requestIds: [],
        environmentId: "",
      },
    );
  });

  it("opens one runner tab per target and keeps it in step with the tree", () => {
    expect(openRunnerFor("missing")).toBeNull();
    const id = openRunnerFor("f1")!;
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "f1", name: "Users" });
    expect(activeTab().doc?.runner?.targetKind).toBe("folder");
    expect(tabTitle(activeTab())).toBe("Run Users");
    useTabsStore.getState().updateRunner(id, { iterations: 5 });
    useTabsStore.getState().activate("t1");
    expect(openRunnerFor("f1")).toBe(id);
    expect(activeTab().doc?.runner?.iterations).toBe(5);
    // Not a runner tab: nothing changes.
    useTabsStore.getState().updateRunner("t1", { iterations: 9 });

    // Renamed in the tree: the tab follows; deleted: the tab closes.
    useWorkspaceStore.setState({
      collections: [col("c1", "API", [folder("f1", "People", [req("r1", "List")])])],
    });
    syncContainerTabs();
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.doc?.name).toBe("People");
    useWorkspaceStore.setState({ collections: [col("c1", "API")] });
    syncContainerTabs();
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toBeUndefined();
  });

  it("restores a runner tab's settings from storage", async () => {
    const stored = {
      state: {
        activeId: "x",
        tabs: [
          {
            id: "x",
            request: {},
            saved: null,
            parentId: "",
            workspaceId: "w1",
            doc: {
              kind: "runner",
              targetId: "f1",
              name: "Users",
              runner: {
                targetKind: "folder",
                excludedIds: ["r1", 3],
                iterations: "x",
                keepVariables: false,
                environmentId: "e1",
                dataFile: "/d.csv",
              },
            },
          },
          { id: "y", request: {}, doc: { kind: "runner", targetId: "c1" } },
        ],
      },
      version: 1,
    };
    localStorage.setItem("pakpos-tabs", JSON.stringify(stored));
    await useTabsStore.persist.rehydrate();
    const [x, y] = useTabsStore.getState().tabs;
    expect(x.doc?.runner).toEqual({
      ...defaultRunnerSettings("folder"),
      excludedIds: ["r1"],
      keepVariables: false,
      environmentId: "e1",
      dataFile: "/d.csv",
    });
    expect(y.doc?.runner).toEqual(defaultRunnerSettings("collection"));
    expect(y.doc?.name).toBe("");
    localStorage.removeItem("pakpos-tabs");
  });
});

function renderPalette() {
  render(
    <TooltipProvider>
      <CommandPalette />
    </TooltipProvider>,
  );
}

async function runAction(text: string) {
  const user = userEvent.setup();
  act(() => usePaletteStore.getState().openPalette());
  await user.type(await screen.findByRole("combobox"), text);
  await user.keyboard("{Enter}");
  return user;
}

describe("palette", () => {
  it("runs a collection through a step, or directly from its settings tab", async () => {
    renderPalette();
    const user = await runAction(">run collection");
    expect(screen.getByRole("navigation", { name: "Palette steps" })).toHaveTextContent("Run collection");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["API", "Orders"]);
    await user.type(screen.getByRole("combobox"), "ord");
    await user.keyboard("{Enter}");
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "c2" });

    useTabsStore.getState().openDoc("collection", "c1", "API", "w1");
    await runAction(">run collection");
    await waitFor(() => expect(usePaletteStore.getState().open).toBe(false));
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "c1" });
  });

  it("runs a folder from its runner tab, through a step, or explains no match", async () => {
    renderPalette();
    const user = await runAction(">run folder");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "UsersAPI / Users",
      "DeepAPI / Users / Deep",
      "RefundsOrders / Refunds",
    ]);
    await user.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    openRunnerFor("f2");
    await runAction(">run folder");
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "f2" });

    // The only collection runs without a step; no folders hides the action.
    useWorkspaceStore.setState({ collections: [col("c9", "Solo")] });
    resetTabs();
    await runAction(">run collection");
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "c9" });
    act(() => usePaletteStore.getState().openPalette(">run folder"));
    expect(screen.queryByRole("option", { name: "Run folder…" })).not.toBeInTheDocument();
  });

  it("opens a past run from the run history step", async () => {
    vi.mocked(api.listRuns).mockResolvedValue([
      makeRunListItem("a", { target: { id: "f1", kind: "folder", name: "Users", path: [] } }),
      makeRunListItem("gone", {
        target: { id: "f9", kind: "folder", name: "Old", path: [] },
        environmentName: "",
      }),
    ]);
    vi.mocked(api.getRun).mockResolvedValue(makeRunReport({ id: "a" }));
    renderPalette();
    const user = await runAction(">run history");
    const opts = await screen.findAllByRole("option");
    expect(opts[0]).toHaveTextContent("Users ·");
    expect(opts[0]).toHaveTextContent("2 passed, 0 failed, 0 errors");
    expect(opts[1]).toHaveTextContent("No environment");
    await user.click(opts[1]);
    expect(toast.error).toHaveBeenCalledWith("Couldn't open the run", {
      description: 'Its folder "Old" no longer exists.',
    });

    await runAction(">run history");
    await user.type(screen.getByRole("combobox"), "users");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(useRunnerStore.getState().shown.f1).toBe("a"));
    expect(activeTab().doc).toMatchObject({ kind: "runner", targetId: "f1" });

    vi.mocked(api.listRuns).mockResolvedValue([]);
    await runAction(">run history");
    expect(await screen.findByText(/No past runs yet/)).toBeInTheDocument();
    await user.type(screen.getByRole("combobox"), "x");
    expect(screen.getByText(/No past runs match/)).toBeInTheDocument();
  });
});

describe("console", () => {
  it("shows runner sends under a header with the iteration", () => {
    useConsoleStore.getState().addRunSend(
      "run-1:0",
      {
        method: "GET",
        name: "List",
        status: "200 OK",
        startedAt: Date.now(),
        context: "Run API · Iteration 2",
      },
      [makeConsoleEntry("hi")],
    );
    useConsoleStore
      .getState()
      .addRunSend(
        "run-1:1",
        { method: "GET", name: "Quiet", status: "200 OK", startedAt: Date.now(), context: "x" },
        [],
      );
    render(
      <TooltipProvider>
        <ConsoleDrawer />
      </TooltipProvider>,
    );
    expect(screen.getByRole("group", { name: "GET List (Run API · Iteration 2)" })).toHaveTextContent("hi");
    expect(useConsoleStore.getState().groups).toHaveLength(1);
    expect(useConsoleStore.getState().unread).toBe(1);
  });
});
