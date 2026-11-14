import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DndContextProps } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { makeEnv, makeVar } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useLayoutStore } from "@/stores/layout";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";
import { EnvironmentsView } from "./EnvironmentsView";

const captured: { props: DndContextProps | null } = { props: null };
vi.mock("@dnd-kit/core", async (orig) => {
  const actual = await orig<typeof import("@dnd-kit/core")>();
  const React = await import("react");
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      captured.props = props;
      return React.createElement(actual.DndContext, props);
    },
  };
});

const ws = { id: "w1", name: "Shop", path: "/shop" };
const envs = [makeEnv("e1", "Dev", [makeVar("a", "1")]), makeEnv("e2", "Staging"), makeEnv("e3", "Prod")];
const store = () => useEnvironmentsStore.getState();

function ready(selectedId = "e1", list = envs) {
  useWorkspaceStore.setState({ status: "ready", workspace: ws });
  useEnvironmentsStore.setState({
    status: "ready",
    workspaceId: "w1",
    environments: list,
    globals: { id: "g", variables: [makeVar("g", "1"), makeVar("h", "2")] },
    selectedId,
  });
  vi.mocked(api.listEnvironments).mockResolvedValue(list);
  vi.mocked(api.selectedEnvironment).mockResolvedValue(list.find((e) => e.id === selectedId) ?? null);
}

function renderView(ui = <EnvironmentsView />) {
  const user = userEvent.setup();
  render(<TooltipProvider>{ui}</TooltipProvider>);
  return user;
}

const row = (name: string | RegExp) =>
  within(screen.getByRole("list", { name: "Environments" })).getByRole("button", { name });

beforeEach(() => {
  resetTabs();
  useLayoutStore.setState({ sidebarView: "environments" });
});

describe("EnvironmentsView states", () => {
  it("asks for a workspace first", async () => {
    useWorkspaceStore.setState({ status: "none", workspace: null });
    const user = renderView();
    expect(screen.getByText("No workspace open")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to collections" }));
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
  });

  it("shows loading states", () => {
    useWorkspaceStore.setState({ status: "loading" });
    const { unmount } = render(<EnvironmentsView />);
    expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
    unmount();
    useWorkspaceStore.setState({ status: "ready", workspace: ws });
    useEnvironmentsStore.setState({ status: "loading" });
    renderView();
    expect(screen.getByText("Loading environments…")).toBeInTheDocument();
  });

  it("shows a load error with retry", async () => {
    useWorkspaceStore.setState({ status: "ready", workspace: ws });
    useEnvironmentsStore.setState({ status: "error", error: "bad yaml in dev.yaml" });
    const user = renderView();
    expect(screen.getByText("Couldn't load environments")).toBeInTheDocument();
    expect(screen.getByText("bad yaml in dev.yaml")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(store().status).toBe("ready"));
  });

  it("tells the user to create the first environment", async () => {
    ready("", []);
    vi.mocked(api.createEnvironment).mockResolvedValue(makeEnv("e9", "New environment"));
    const user = renderView();
    expect(screen.getByText("No environments yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create environment" }));
    expect(api.createEnvironment).toHaveBeenCalledWith("New environment");
  });
});

describe("EnvironmentsView list", () => {
  it("lists globals and environments, and opens editors", async () => {
    ready();
    const user = renderView();
    expect(row(/^Dev/)).toHaveAttribute("aria-current", "true");
    expect(within(row(/^Dev/)).getByText("In use")).toBeInTheDocument();
    await user.click(row(/^Staging/));
    await user.click(screen.getByRole("button", { name: /^Globals/ }));
    expect(
      useTabsStore
        .getState()
        .tabs.filter((t) => t.doc)
        .map((t) => t.doc!.kind),
    ).toEqual(["environment", "globals"]);
    await user.click(screen.getByRole("button", { name: "New environment" }));
    expect(api.createEnvironment).toHaveBeenCalled();
  });

  it("reorders with Alt+arrows and moves focus with arrows", async () => {
    ready();
    const user = renderView();
    row(/^Staging/).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(api.reorderEnvironments).toHaveBeenCalledWith(["e2", "e1", "e3"]);
    vi.mocked(api.reorderEnvironments).mockClear();
    ready();
    row(/^Prod/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(api.reorderEnvironments).not.toHaveBeenCalled();

    await act(() => new Promise((r) => requestAnimationFrame(r)));
    row(/^Dev/).focus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Staging/)).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(row(/^Dev/)).toHaveFocus();
  });

  it("renames with F2 and deletes with Delete after confirming", async () => {
    ready();
    const user = renderView();
    row(/^Staging/).focus();
    await user.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: "Environment name" });
    await user.clear(input);
    await user.type(input, "QA{Enter}");
    expect(api.renameEnvironment).toHaveBeenCalledWith("e2", "QA");

    row(/^Prod/).focus();
    await user.keyboard("{Delete}");
    const dialog = await screen.findByRole("alertdialog", { name: 'Delete the environment "Prod"?' });
    await user.click(within(dialog).getByRole("button", { name: "Delete environment" }));
    await waitFor(() => expect(api.deleteEnvironment).toHaveBeenCalledWith("e3"));
  });

  it("starts a new environment in rename mode", async () => {
    ready();
    useEnvironmentsStore.setState({ renameTarget: "e2" });
    const user = renderView();
    const input = await screen.findByRole("textbox", { name: "Environment name" });
    await user.keyboard("{Escape}");
    expect(input).not.toBeInTheDocument();
    expect(store().renameTarget).toBeNull();
  });

  it("offers every action in the row menu", async () => {
    ready();
    vi.mocked(api.duplicateEnvironment).mockResolvedValue(makeEnv("e4", "Staging copy"));
    const user = renderView();
    const menu = (name: string) => screen.getByRole("button", { name: `More actions for ${name}` });

    await user.click(menu("Staging"));
    await user.click(await screen.findByRole("menuitem", { name: "Use this environment" }));
    expect(api.selectEnvironment).toHaveBeenCalledWith("e2");

    await user.click(menu("Staging"));
    await user.click(await screen.findByRole("menuitem", { name: "Stop using" }));
    expect(api.selectEnvironment).toHaveBeenLastCalledWith("");

    await user.click(menu("Staging"));
    await user.click(await screen.findByRole("menuitem", { name: /Move down/ }));
    expect(api.reorderEnvironments).toHaveBeenLastCalledWith(["e1", "e3", "e2"]);

    ready();
    await user.click(menu("Staging"));
    await user.click(await screen.findByRole("menuitem", { name: /Move up/ }));
    expect(api.reorderEnvironments).toHaveBeenLastCalledWith(["e2", "e1", "e3"]);

    ready();
    await user.click(menu("Staging"));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(api.duplicateEnvironment).toHaveBeenCalledWith("e2");

    await user.click(menu("Dev"));
    await user.click(await screen.findByRole("menuitem", { name: /^Rename/ }));
    expect(await screen.findByRole("textbox", { name: "Environment name" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(menu("Dev"));
    await user.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(useTabsStore.getState().tabs.some((t) => t.doc?.targetId === "e1")).toBe(true);
  });

  it("reorders by drag and drop", () => {
    ready();
    renderView();
    const end = captured.props!.onDragEnd!;
    act(() => end({ active: { id: "e3" }, over: { id: "e1" } } as never));
    expect(api.reorderEnvironments).toHaveBeenCalledWith(["e3", "e1", "e2"]);
    vi.mocked(api.reorderEnvironments).mockClear();
    act(() => end({ active: { id: "e3" }, over: null } as never));
    act(() => end({ active: { id: "e3" }, over: { id: "e3" } } as never));
    expect(api.reorderEnvironments).not.toHaveBeenCalled();
  });
});

describe("EnvironmentSwitcher", () => {
  it("is hidden without a workspace", () => {
    useWorkspaceStore.setState({ workspace: null });
    const { container } = render(<EnvironmentSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it("switches environments, opens globals and the manage view", async () => {
    ready("");
    useLayoutStore.setState({ sidebarView: "collections" });
    const user = renderView(<EnvironmentSwitcher />);
    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(trigger).toHaveTextContent("No environment");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Staging" }));
    expect(api.selectEnvironment).toHaveBeenCalledWith("e2");
    expect(trigger).toHaveTextContent("Staging");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "No environment" }));
    expect(api.selectEnvironment).toHaveBeenLastCalledWith("");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Edit globals" }));
    expect(useTabsStore.getState().tabs.some((t) => t.doc?.kind === "globals")).toBe(true);
    expect(trigger).toHaveTextContent("No environment");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Manage environments…" }));
    expect(useLayoutStore.getState().sidebarView).toBe("environments");
  });

  it("works from the keyboard", async () => {
    ready("e1");
    const user = renderView(<EnvironmentSwitcher />);
    screen.getByRole("combobox", { name: "Environment" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(api.selectEnvironment).toHaveBeenCalledWith("e2"));
  });
});
