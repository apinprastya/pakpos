import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { api, type WorkspaceChange } from "@/lib/api";
import { emptyAuth } from "@/lib/model";
import { col, folder, makeEnv, makeResult, makeVar } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { VariablesNotice } from "@/features/response/ResponsePane";
import { useLayoutStore } from "@/stores/layout";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore } from "@/stores/tabs";

const ws = { id: "w1", name: "Shop API", path: "/work/shop" };
let listeners: ((c: WorkspaceChange) => void)[] = [];

function boot() {
  listeners = [];
  vi.mocked(api.onWorkspaceChanged).mockImplementation((cb) => {
    listeners.push(cb);
    return () => {};
  });
  vi.mocked(api.currentWorkspace).mockResolvedValue(ws);
  vi.mocked(api.tree).mockResolvedValue({
    collections: [col("c1", "Users", [folder("f1", "Admin")])],
    problems: [],
  });
  vi.mocked(api.listEnvironments).mockResolvedValue([makeEnv("e1", "Dev", [makeVar("a", "1")])]);
  vi.mocked(api.selectedEnvironment).mockResolvedValue({ id: "e1", name: "Dev" });
  vi.mocked(api.getEnvironment).mockResolvedValue(makeEnv("e1", "Dev", [makeVar("a", "1")]));
  vi.mocked(api.getCollection).mockResolvedValue({
    id: "c1",
    name: "Users",
    auth: emptyAuth(),
    headers: [],
    variables: [],
  });
  const user = userEvent.setup();
  render(<App />);
  return user;
}

beforeEach(() => {
  resetTabs();
  useLayoutStore.setState({ sidebarView: "collections", splitOrientation: "vertical" });
});

describe("environments in the app", () => {
  it("loads environments for the workspace and shows the selection", async () => {
    boot();
    const footer = screen.getByRole("contentinfo");
    expect(await within(footer).findByText("Dev")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("Dev");
    await userEvent.click(
      within(footer).getByRole("button", { name: "Environment: Dev. Manage environments" }),
    );
    expect(useLayoutStore.getState().sidebarView).toBe("environments");
    expect(await screen.findByRole("list", { name: "Environments" })).toBeInTheDocument();
  });

  it("reloads environments on external changes", async () => {
    boot();
    await within(screen.getByRole("contentinfo")).findByText("Dev");
    vi.mocked(api.listEnvironments).mockResolvedValue([makeEnv("e1", "Development")]);
    vi.mocked(api.selectedEnvironment).mockResolvedValue({ id: "e1", name: "Development" });
    await act(async () => listeners.forEach((l) => l({ workspaceId: "w1", problems: [] })));
    expect(await within(screen.getByRole("contentinfo")).findByText("Development")).toBeInTheDocument();
    await act(async () => listeners.forEach((l) => l({ workspaceId: "other", problems: [] })));
  });

  it("opens an environment tab in place of the request, saves it with Mod+S and asks before closing", async () => {
    const user = boot();
    await within(screen.getByRole("contentinfo")).findByText("Dev");
    act(() => {
      useTabsStore.getState().openDoc("environment", "e1", "Dev", "w1");
    });
    const value = await screen.findByLabelText("Value 1");
    expect(screen.queryByRole("region", { name: "Request" })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tablist", { name: "Open tabs" })).getByRole("tab", { name: "Dev" }),
    ).toBeInTheDocument();

    await user.type(value, "2");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(api.saveVariables).toHaveBeenCalledWith(
        { kind: "environment", id: "e1" },
        [makeVar("a", "12")],
        [],
      ),
    );

    await user.type(screen.getByLabelText("Value 1"), "3");
    await user.click(screen.getByRole("button", { name: "Close Dev (unsaved changes)" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save changes to Dev?" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveVariables).toHaveBeenLastCalledWith(
        { kind: "environment", id: "e1" },
        [makeVar("a", "123")],
        [],
      ),
    );
    await waitFor(() => expect(useTabsStore.getState().tabs.some((t) => t.doc)).toBe(false));
  });

  it("closes tabs of another workspace when one opens", async () => {
    useTabsStore.getState().openDoc("environment", "x", "Old", "other");
    boot();
    await within(screen.getByRole("contentinfo")).findByText("Dev");
    expect(useTabsStore.getState().tabs.some((t) => t.doc)).toBe(false);
  });

  it("opens collection settings from the tree menu", async () => {
    const user = boot();
    const row = await screen.findByRole("treeitem", { name: /Users/ });
    fireEvent.contextMenu(within(row).getByText("Users"));
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(activeTab().doc).toMatchObject({ kind: "collection", targetId: "c1" });
    expect(await screen.findByRole("heading", { name: "Users" })).toBeInTheDocument();
  });

  it("shows a lock indicator for the file store and opens the unlock dialog", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    const user = boot();
    await user.click(await screen.findByRole("button", { name: "Secrets locked. Unlock secrets" }));
    expect(await screen.findByRole("dialog", { name: "Unlock secrets" })).toBeInTheDocument();
  });
});

describe("response notice", () => {
  it("offers to unlock when secrets were locked", async () => {
    render(<VariablesNotice result={makeResult({ secretsLocked: true, unresolved: ["token"] })} />);
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(useSecretsStore.getState().dialog).toBe("unlock");
  });

  it("refreshes the secret store status after a locked send", async () => {
    resetTabs({ url: "https://x" });
    vi.mocked(api.send).mockResolvedValue(makeResult({ secretsLocked: true }));
    const { sendTab } = await import("@/features/request/actions");
    await sendTab("t1");
    expect(api.secretsStatus).toHaveBeenCalled();
  });
});
