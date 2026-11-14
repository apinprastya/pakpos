import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { emptyAuth, type Auth } from "@/lib/model";
import { col, folder, makeEnv, makePreview, makeVar } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { moveToSecret, scopeOptions, variableNameError } from "@/features/scopes/moveToSecret";
import { RequestPane } from "./RequestPane";
import { isLiteralSecret } from "./auth";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const ws = { id: "w1", name: "Shop", path: "/shop" };
const users = { kind: "collection" as const, id: "c1", name: "Users" };

function setup(auth: Partial<Auth> = {}, parentId = "f1") {
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    treeLoaded: true,
    collections: [col("c1", "Users", [folder("f1", "Admin")])],
  });
  useEnvironmentsStore.setState({
    status: "ready",
    workspaceId: "w1",
    environments: [makeEnv("e1", "Dev")],
    selectedId: "e1",
  });
  resetTabs({ url: "https://x", auth: { ...emptyAuth(), ...auth } }, { parentId, workspaceId: "w1" });
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <RequestPane />
    </TooltipProvider>,
  );
  return user;
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("inherited headers", () => {
  it("lists inherited headers with their source, which opens its settings", async () => {
    vi.mocked(api.resolvePreview).mockResolvedValue(
      makePreview({
        headers: [
          { key: "Accept", value: "application/json", source: users },
          { key: "X-Admin", value: "1", source: { kind: "folder", id: "f1", name: "Admin" } },
        ],
      }),
    );
    const user = setup();
    await user.click(tab("Headers"));
    const list = await screen.findByRole("list", { name: "Inherited headers" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Acceptapplication/jsonfromUsers");
    expect(api.resolvePreview).toHaveBeenCalledWith(expect.objectContaining({ url: "https://x" }), "f1");
    await user.click(within(list).getByRole("button", { name: "Open Admin settings" }));
    expect(activeTab().doc).toMatchObject({ kind: "folder", targetId: "f1", name: "Admin" });
  });

  it("says when nothing is inherited, and shows errors", async () => {
    const user = setup();
    await user.click(tab("Headers"));
    expect(screen.getByText("Checking inherited headers…")).toBeInTheDocument();
    expect(await screen.findByText(/None. Headers set on the collection/)).toBeInTheDocument();
    useTabsStore.getState().updateRequest("t1", (r) => ({ ...r, url: "https://y" }));
    vi.mocked(api.resolvePreview).mockRejectedValueOnce(new Error("boom"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check inherited headers: boom");
  });

  it("is hidden for a request outside a collection", async () => {
    const user = setup({}, "");
    await user.click(tab("Headers"));
    expect(screen.queryByText("Inherited")).not.toBeInTheDocument();
  });
});

describe("inherited auth", () => {
  it("shows the effective auth and links to its source", async () => {
    vi.mocked(api.resolvePreview).mockResolvedValue(
      makePreview({ auth: { ...emptyAuth(), type: "apikey" }, authSource: users }),
    );
    const user = setup({ type: "inherit" });
    await user.click(tab("Auth"));
    expect(await screen.findByText(/Uses/)).toHaveTextContent("Uses API key from the collection Users");
    await user.click(screen.getByRole("button", { name: "Open Users settings" }));
    expect(activeTab().doc).toMatchObject({ kind: "collection", targetId: "c1" });
  });

  it("says when nothing upstream sets auth", async () => {
    const user = setup({ type: "inherit" });
    await user.click(tab("Auth"));
    expect(
      await screen.findByText("No auth is set on the collection or its folders, so none is sent."),
    ).toBeInTheDocument();
  });

  it("explains preview errors", async () => {
    vi.mocked(api.resolvePreview).mockRejectedValue(new Error("nope"));
    const user = setup({ type: "inherit" });
    await user.click(tab("Auth"));
    expect(await screen.findByText("Couldn't check the inherited auth: nope")).toBeInTheDocument();
  });
});

describe("move to secret variable", () => {
  it("hints on literal values and moves one to the selected environment", async () => {
    vi.mocked(api.getEnvironment).mockResolvedValue(makeEnv("e1", "Dev", [makeVar("other", "1")]));
    const user = setup({ type: "bearer", token: "abc123" });
    await user.click(tab("Auth"));
    expect(screen.getByText("This value is saved in the file as plain text.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move to secret variable" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to secret variable" });
    expect(within(dialog).getByLabelText("Variable name")).toHaveValue("token");
    expect(within(dialog).getByRole("combobox", { name: "Store in" })).toHaveTextContent("Environment: Dev");
    const name = within(dialog).getByLabelText("Variable name");
    await user.clear(name);
    await user.type(name, "bad name");
    await user.click(within(dialog).getByRole("button", { name: "Move to secret" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/without spaces/);
    await user.clear(name);
    await user.type(name, "devToken");
    await user.click(within(dialog).getByRole("button", { name: "Move to secret" }));
    await waitFor(() => expect(activeTab().request.auth.token).toBe("{{devToken}}"));
    expect(api.setSecret).toHaveBeenCalledWith({ kind: "environment", id: "e1" }, "devToken", "abc123");
    expect(api.saveVariables).toHaveBeenCalledWith({ kind: "environment", id: "e1" }, [
      makeVar("other", "1"),
      makeVar("devToken", "", { secret: true }),
    ]);
    expect(screen.queryByText("This value is saved in the file as plain text.")).not.toBeInTheDocument();
  });

  it("stores in the collection or globals, and reports a taken name", async () => {
    vi.mocked(api.getCollection).mockResolvedValue({
      id: "c1",
      name: "Users",
      auth: emptyAuth(),
      headers: [],
      variables: [makeVar("password", "x")],
    });
    const user = setup({ type: "basic", password: "hunter2" });
    await user.click(tab("Auth"));
    await user.click(screen.getByRole("button", { name: "Move to secret variable" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Store in" }));
    await user.click(screen.getByRole("option", { name: "Collection: Users" }));
    await user.click(within(dialog).getByRole("button", { name: "Move to secret" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Collection: Users already has a variable named password. Choose another name.",
    );
    await user.click(within(dialog).getByRole("combobox", { name: "Store in" }));
    await user.click(screen.getByRole("option", { name: "Globals" }));
    await user.click(within(dialog).getByRole("button", { name: "Move to secret" }));
    await waitFor(() => expect(activeTab().request.auth.password).toBe("{{password}}"));
    expect(api.setSecret).toHaveBeenCalledWith({ kind: "global", id: "" }, "password", "hunter2");
  });

  it("offers it for an API key value and cancels", async () => {
    const user = setup({ type: "apikey", apiKey: "X-Key", apiValue: "v" });
    await user.click(tab("Auth"));
    await user.click(screen.getByRole("button", { name: "Move to secret variable" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Variable name")).toHaveValue("apiKey");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(activeTab().request.auth.apiValue).toBe("v");
  });
});

describe("move to secret helpers", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: [col("c1", "Users")] });
    useEnvironmentsStore.setState({ environments: [makeEnv("e1", "Dev")], selectedId: "" });
  });

  it("lists scopes: selected environment, collection, globals", () => {
    expect(scopeOptions("c1").map((o) => o.label)).toEqual(["Collection: Users", "Globals"]);
    expect(scopeOptions("").map((o) => o.label)).toEqual(["Globals"]);
    useEnvironmentsStore.setState({ selectedId: "e1" });
    expect(scopeOptions("c1")[0]).toEqual({
      value: "environment",
      scope: { kind: "environment", id: "e1" },
      label: "Environment: Dev",
    });
  });

  it("checks names", () => {
    expect(variableNameError("")).toBe("Enter a variable name.");
    expect(variableNameError("a{b")).toMatch(/without spaces or braces/);
    expect(variableNameError("$guid")).toMatch(/reserved/);
    expect(variableNameError("ok_name")).toBeNull();
  });

  it("refuses while the scope has unsaved edits, and stops when unlocking is cancelled", async () => {
    const id = useTabsStore.getState().openDoc("globals", "", "Globals", "w1");
    useTabsStore.getState().markDocSaved(id, { auth: emptyAuth(), headers: [], variables: [] });
    useTabsStore.getState().updateDoc(id, (d) => ({ ...d, variables: [makeVar("x", "1")] }));
    await expect(moveToSecret({ kind: "global", id: "" }, "Globals", "t", "v")).rejects.toThrow(
      'Save or discard your changes in "Globals" first.',
    );

    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    vi.mocked(api.getCollection).mockResolvedValue({
      id: "c1",
      name: "Users",
      auth: emptyAuth(),
      headers: [],
      variables: [],
    });
    const pending = moveToSecret({ kind: "collection", id: "c1" }, "Collection", "t", "v").catch((e) => e);
    await waitFor(() => expect(useSecretsStore.getState().dialog).toBe("unlock"));
    useSecretsStore.getState().closeDialog(false);
    expect(await pending).toBe(false);
    expect(api.setSecret).not.toHaveBeenCalled();
  });

  it("knows literal values", () => {
    expect(isLiteralSecret("abc")).toBe(true);
    expect(isLiteralSecret("  ")).toBe(false);
    expect(isLiteralSecret("{{token}}")).toBe(false);
    expect(isLiteralSecret("Bearer {{token}}")).toBe(false);
  });
});
