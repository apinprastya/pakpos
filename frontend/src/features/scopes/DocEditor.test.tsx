import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { emptyAuth } from "@/lib/model";
import { col, folder, makeEnv, makePreview, makeVar } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore, type DocKind } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { DocEditor } from "./DocEditor";

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tabs = () => useTabsStore.getState();

function Active() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)!);
  return tab.doc ? <DocEditor key={tab.id} tab={tab} /> : <p>request tab</p>;
}

function openDoc(kind: DocKind, id: string, name = id) {
  const user = userEvent.setup();
  tabs().openDoc(kind, id, name, "w1");
  render(
    <TooltipProvider>
      <Active />
    </TooltipProvider>,
  );
  return user;
}

beforeEach(() => {
  resetTabs();
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    treeLoaded: true,
    collections: [col("c1", "Users", [folder("f1", "Admin")])],
  });
  const dev = makeEnv("e1", "Dev", [makeVar("baseUrl", "https://dev")]);
  useEnvironmentsStore.setState({ status: "ready", workspaceId: "w1", environments: [dev], selectedId: "" });
  vi.mocked(api.getEnvironment).mockResolvedValue(dev);
  vi.mocked(api.listEnvironments).mockResolvedValue([dev]);
  vi.mocked(api.getCollection).mockResolvedValue({
    id: "c1",
    name: "Users",
    auth: { ...emptyAuth(), type: "bearer", token: "literal-token" },
    headers: [{ key: "Accept", value: "application/json", enabled: true }],
    variables: [makeVar("v", "1")],
  });
  vi.mocked(api.getFolder).mockResolvedValue({
    id: "f1",
    name: "Admin",
    auth: { ...emptyAuth(), type: "inherit" },
    headers: [],
  });
});

describe("environment editor", () => {
  it("loads, edits and saves with the Save button", async () => {
    const user = openDoc("environment", "e1", "Dev");
    expect(screen.getByRole("status")).toHaveTextContent("Loading Dev…");
    const value = await screen.findByLabelText("Value 1");
    expect(screen.getByRole("heading", { name: "Dev" })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(value, "/v2");
    expect(screen.getByText("· Unsaved changes")).toBeInTheDocument();
    await user.click(save);
    await waitFor(() =>
      expect(api.saveVariables).toHaveBeenCalledWith(
        { kind: "environment", id: "e1" },
        [makeVar("baseUrl", "https://dev/v2")],
        [],
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("selects the environment and shows when it's in use", async () => {
    const user = openDoc("environment", "e1", "Dev");
    await user.click(await screen.findByRole("button", { name: "Use this environment" }));
    expect(api.selectEnvironment).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("In use")).toBeInTheDocument();
  });

  it("renames, duplicates and deletes from the menu", async () => {
    vi.mocked(api.duplicateEnvironment).mockResolvedValue(makeEnv("e2", "Dev copy"));
    vi.mocked(api.listEnvironments).mockResolvedValue([makeEnv("e1", "Dev"), makeEnv("e2", "Dev copy")]);
    const user = openDoc("environment", "e1", "Dev");
    await screen.findByLabelText("Value 1");
    const menu = () => screen.getByRole("button", { name: "More actions for Dev" });

    await user.click(menu());
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = await screen.findByRole("textbox", { name: "Environment name" });
    await user.clear(name);
    await user.type(name, "Development{Enter}");
    expect(api.renameEnvironment).toHaveBeenCalledWith("e1", "Development");

    await user.click(menu());
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: 'Delete the environment "Dev"?' });
    await user.click(within(dialog).getByRole("button", { name: "Delete environment" }));
    await waitFor(() => expect(api.deleteEnvironment).toHaveBeenCalledWith("e1"));
  });

  it("duplicates and opens the copy", async () => {
    vi.mocked(api.duplicateEnvironment).mockResolvedValue(makeEnv("e2", "Dev copy"));
    vi.mocked(api.listEnvironments).mockResolvedValue([makeEnv("e1", "Dev"), makeEnv("e2", "Dev copy")]);
    const user = openDoc("environment", "e1", "Dev");
    await screen.findByLabelText("Value 1");
    await user.click(screen.getByRole("button", { name: "More actions for Dev" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(tabs().tabs.find((t) => t.id === tabs().activeId)?.doc?.targetId).toBe("e2"));
  });

  it("renames with a double click on the title and cancels with Escape", async () => {
    const user = openDoc("environment", "e1", "Dev");
    await screen.findByLabelText("Value 1");
    await user.dblClick(screen.getByRole("heading", { name: "Dev" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "Dev" })).toBeInTheDocument();
    expect(api.renameEnvironment).not.toHaveBeenCalled();
  });

  it("shows a load error with retry and close", async () => {
    vi.mocked(api.getEnvironment).mockRejectedValueOnce(new Error("environment not found"));
    const user = openDoc("environment", "e1", "Dev");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load Dev");
    expect(alert).toHaveTextContent("environment not found");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Value 1")).toBeInTheDocument();

    vi.mocked(api.getEnvironment).mockRejectedValueOnce(new Error("gone"));
    tabs().openDoc("environment", "e9", "Gone", "w1");
    await user.click(await screen.findByRole("button", { name: "Close tab" }));
    expect(tabs().tabs.some((t) => t.doc?.targetId === "e9")).toBe(false);
  });

  it("explains a deleted environment and disables Save", async () => {
    openDoc("environment", "e1", "Dev");
    await screen.findByLabelText("Value 1");
    const id = tabs().activeId;
    tabs().updateDoc(id, (d) => ({ ...d, variables: [] }));
    tabs().patchDoc(id, { missing: true });
    expect(await screen.findByText(/deleted outside the app/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("says where secret values live", async () => {
    useSecretsStore.setState({ status: { backend: "file", hasPassword: true, locked: false } });
    openDoc("environment", "e1", "Dev");
    expect(await screen.findByText(/in an encrypted file on this machine/)).toBeInTheDocument();
  });
});

describe("globals editor", () => {
  it("edits the global variables", async () => {
    vi.mocked(api.getGlobals).mockResolvedValue({ id: "g", variables: [makeVar("ua", "pakpos")] });
    const user = openDoc("globals", "", "Globals");
    expect(await screen.findByRole("table", { name: "Global variables" })).toBeInTheDocument();
    expect(screen.getByText(/available in every request/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Variable 2"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveGlobals).toHaveBeenCalledWith([makeVar("ua", "pakpos"), makeVar("x", "")], []),
    );
  });
});

describe("collection and folder settings", () => {
  it("edits a collection's auth, headers and variables", async () => {
    const user = openDoc("collection", "c1", "Users");
    await user.click(await screen.findByRole("combobox", { name: "Type" }));
    expect(screen.queryByRole("option", { name: "Inherit from parent" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Basic auth" }));
    await user.type(screen.getByLabelText("Username"), "ada");

    await user.click(screen.getByRole("tab", { name: "Headers" }));
    await user.type(screen.getByLabelText("Value 1"), "+x");

    await user.click(screen.getByRole("tab", { name: "Variables" }));
    expect(screen.getByRole("table", { name: "Users variables" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Value 1"), "0");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveCollection).toHaveBeenCalledWith(
        "c1",
        {
          auth: expect.objectContaining({ type: "basic", username: "ada" }),
          headers: [{ key: "Accept", value: "application/json+x", enabled: true }],
          variables: [makeVar("v", "10")],
        },
        [],
      ),
    );
  });

  it("moves a literal token to a secret variable", async () => {
    vi.mocked(api.getCollection).mockResolvedValue({
      id: "c1",
      name: "Users",
      auth: { ...emptyAuth(), type: "bearer", token: "literal-token" },
      headers: [],
      variables: [],
    });
    const user = openDoc("collection", "c1", "Users");
    await user.click(await screen.findByRole("button", { name: "Move to secret variable" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to secret variable" });
    expect(within(dialog).getByRole("combobox", { name: "Store in" })).toHaveTextContent("Collection: Users");
    await user.click(within(dialog).getByRole("button", { name: "Move to secret" }));
    await waitFor(() =>
      expect(api.setSecret).toHaveBeenCalledWith({ kind: "collection", id: "c1" }, "token", "literal-token"),
    );
    await waitFor(() => expect(screen.getByLabelText("Token")).toHaveValue("{{token}}"));
  });

  it("offers inherit on a folder and shows what it resolves to", async () => {
    vi.mocked(api.resolvePreview).mockResolvedValue(
      makePreview({
        auth: { ...emptyAuth(), type: "bearer" },
        authSource: { kind: "collection", id: "c1", name: "Users" },
      }),
    );
    const user = openDoc("folder", "f1", "Admin");
    expect(await screen.findByText(/Uses/)).toHaveTextContent("Uses Bearer token from the collection Users");
    expect(api.resolvePreview).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ type: "inherit" }) }),
      "c1",
    );
    expect(screen.queryByRole("tab", { name: "Variables" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Users settings" }));
    expect(tabs().tabs.some((t) => t.doc?.kind === "collection" && t.doc.targetId === "c1")).toBe(true);
  });
});
