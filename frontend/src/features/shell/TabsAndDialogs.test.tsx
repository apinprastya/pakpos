import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import App from "@/App";
import { api } from "@/lib/api";
import { emptyRequest } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { col, folder, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const s = () => useTabsStore.getState();
const tabList = () => screen.getByRole("tablist", { name: "Open requests" });

describe("tab bar", () => {
  beforeEach(() => resetTabs());

  it("opens, switches and closes tabs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "New request" }));
    expect(within(tabList()).getAllByRole("tab")).toHaveLength(2);
    await user.click(within(tabList()).getAllByRole("tab")[0]);
    expect(s().activeId).toBe("t1");
    await user.click(within(tabList()).getAllByRole("button", { name: "Close Untitled request" })[0]);
    expect(within(tabList()).getAllByRole("tab")).toHaveLength(1);
  });

  it("closes with middle click and reorders by drag", () => {
    render(<App />);
    act(() => {
      s().newTab();
      s().newTab();
    });
    const ids = s().tabs.map((t) => t.id);
    const wrappers = within(tabList())
      .getAllByRole("tab")
      .map((t) => t.parentElement!);
    const dt = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(wrappers[2], { dataTransfer: dt });
    fireEvent.dragOver(wrappers[0], { dataTransfer: dt });
    fireEvent.drop(wrappers[0], { dataTransfer: dt });
    fireEvent.dragEnd(wrappers[2]);
    expect(s().tabs.map((t) => t.id)).toEqual([ids[2], ids[0], ids[1]]);
    // dragOver without a drag in progress is ignored.
    fireEvent.dragOver(wrappers[1]);

    fireEvent(wrappers[1], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(s().tabs).toHaveLength(2);
    fireEvent(wrappers[0], new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(s().tabs).toHaveLength(2);
  });

  it("asks before closing unsaved changes: cancel, don't save", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://x" });
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Close Untitled request (unsaved changes)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Save changes to Untitled request?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(s().tabs[0].id).toBe("t1");

    await user.click(screen.getByRole("button", { name: "Close Untitled request (unsaved changes)" }));
    await user.click(await screen.findByRole("button", { name: "Don't save" }));
    expect(s().tabs[0].id).not.toBe("t1");
  });

  it("saves an existing request from the close prompt", async () => {
    const user = userEvent.setup();
    const saved = { ...emptyRequest(), id: "r1", name: "Users" };
    resetTabs({ ...saved, url: "https://changed" }, { saved });
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Close Users (unsaved changes)" }));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(s().tabs[0].id).not.toBe("t1"));
    expect(api.save).toHaveBeenCalled();
  });

  it("handles keyboard shortcuts", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://x" });
    render(<App />);
    await user.keyboard("{Control>}t{/Control}");
    expect(s().tabs).toHaveLength(2);
    await user.keyboard("{Control>}w{/Control}");
    expect(s().tabs).toHaveLength(1);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.send).toHaveBeenCalled());
    await user.keyboard("{Control>}s{/Control}");
    expect(s().saveDialog?.tabId).toBe("t1");
    // Other combinations are ignored.
    await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}{Control>}k{/Control}");
    expect(s().tabs).toHaveLength(1);
  });
});

describe("save dialog", () => {
  beforeEach(() => resetTabs({ url: "https://x", name: "" }));

  it("asks for a workspace when none is open, then saves into a collection", async () => {
    const user = userEvent.setup();
    vi.mocked(api.pickFolder).mockResolvedValue("/work/api");
    vi.mocked(api.openWorkspace).mockRejectedValue(
      new Error("not a pakpos workspace: /work/api has no pakpos.yaml"),
    );
    vi.mocked(api.createWorkspace).mockImplementation(async () => {
      vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w", name: "api", path: "/work/api" });
      vi.mocked(api.collections).mockResolvedValue([col("c1", "Users")]);
      vi.mocked(api.tree).mockResolvedValue({
        collections: [col("c1", "Users", [req("saved-id", "List users", "GET", "https://x")])],
        problems: [],
      });
      return { id: "w", name: "api", path: "/work/api" };
    });
    render(<App />);
    act(() => s().openSaveDialog("t1"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/No workspace is open/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Choose folder" }));
    expect(await within(dialog).findByText("Saved as a file in api.")).toBeInTheDocument();
    expect(api.createWorkspace).toHaveBeenCalledWith("/work/api", "");

    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Untitled request");
    await user.clear(name);
    await user.type(name, "List users");
    await user.click(within(dialog).getByRole("button", { name: "Save request" }));
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledWith("c1", "List users", expect.anything()));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(activeTab().saved?.name).toBe("List users");
  });

  it("creates a new collection inline and closes the tab after saving", async () => {
    const user = userEvent.setup();
    vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w", name: "ws", path: "/ws" });
    vi.mocked(api.collections).mockResolvedValue([]);
    vi.mocked(api.createCollection).mockResolvedValue({ id: "c9", name: "Auth" });
    render(<App />);
    act(() => s().openSaveDialog("t1", true));
    const dialog = await screen.findByRole("dialog");
    const save = await within(dialog).findByRole("button", { name: "Save request" });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText("New collection name"), "Auth");
    await user.click(save);
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledWith("c9", "Untitled request", expect.anything()));
    await waitFor(() => expect(s().tabs[0].id).not.toBe("t1"));
  });

  it("reports failures and can be cancelled", async () => {
    const user = userEvent.setup();
    vi.mocked(api.currentWorkspace).mockRejectedValue(new Error("db locked"));
    render(<App />);
    act(() => s().openSaveDialog("t1"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't load the workspace", expect.anything()),
    );
    vi.mocked(api.pickFolder).mockRejectedValue(new Error("no dialog"));
    await user.click(await screen.findByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't open the folder", expect.anything()),
    );
    vi.mocked(api.pickFolder).mockResolvedValue("");
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(s().saveDialog).toBeNull();
  });

  it("saves into a nested folder picked from the list", async () => {
    const user = userEvent.setup();
    vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w", name: "ws", path: "/ws" });
    const tree = [
      col("c1", "Users", [folder("f1", "Auth", [folder("f2", "Tokens", [req("saved-id")])]), req("r1")]),
      col("c2", "Orders"),
    ];
    vi.mocked(api.collections).mockResolvedValue(tree);
    vi.mocked(api.tree).mockResolvedValue({ collections: tree, problems: [] });
    render(<App />);
    act(() => s().openSaveDialog("t1"));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("combobox", { name: "Save to" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Users",
      "Users / Auth",
      "Users / Auth / Tokens",
      "Orders",
      "New collection…",
    ]);
    // Screen readers get the path; jsdom drops the space at the span boundary.
    await user.click(screen.getByRole("option", { name: /^Users \/ Auth \/\s?Tokens$/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save request" }));
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledWith("f2", "Untitled request", expect.anything()));
    expect(activeTab().parentId).toBe("f2");
  });

  it("reports a failed collection create", async () => {
    const user = userEvent.setup();
    vi.mocked(api.currentWorkspace).mockResolvedValue({ id: "w", name: "ws", path: "/ws" });
    vi.mocked(api.collections).mockResolvedValue([]);
    vi.mocked(api.createCollection).mockRejectedValue(new Error("exists"));
    render(<App />);
    act(() => s().openSaveDialog("t1"));
    const dialog = await screen.findByRole("dialog");
    await user.type(await within(dialog).findByLabelText("New collection name"), "Dup");
    await user.click(within(dialog).getByRole("button", { name: "Save request" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't create the collection", expect.anything()),
    );
    expect(s().saveDialog).not.toBeNull();
  });
});
