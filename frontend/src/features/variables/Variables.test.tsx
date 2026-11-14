import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { emptyAuth } from "@/lib/model";
import { DocEditor } from "@/features/scopes/DocEditor";
import { RequestPane } from "@/features/request/RequestPane";
import { col, makeEnv, makePreview, makePreviewVar, makeVar } from "@/test/fixtures";
import { editorView, fieldText, typeInField } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { useEnvironmentsStore } from "@/stores/environments";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

const visible = [
  makePreviewVar("host", "dev.example"),
  makePreviewVar("token", "", { secret: true, scope: "collection", scopeName: "Users API" }),
];

beforeEach(() => {
  useWorkspaceStore.setState({
    status: "ready",
    workspace: { id: "w1", name: "Shop", path: "/shop" },
    treeLoaded: true,
    collections: [col("c1", "Users API")],
  });
  vi.mocked(api.resolvePreview).mockResolvedValue(
    makePreview({ variables: visible, environment: { id: "e1", name: "Dev" } }),
  );
});

const classes = (el: Element) =>
  [...el.querySelectorAll(".var-token")].map((e) => `${e.textContent} ${e.className}`);

describe("variables in a request tab", () => {
  it("marks references in the URL bar, tables and auth fields from one preview", async () => {
    const user = userEvent.setup();
    resetTabs(
      {
        url: "https://{{host}}/{{nope}}?id={{$guid}}",
        headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }],
        auth: { ...emptyAuth(), type: "basic", username: "{{host}}" },
      },
      { parentId: "c1", workspaceId: "w1" },
    );
    render(
      <TooltipProvider>
        <RequestPane />
      </TooltipProvider>,
    );
    const url = editorView("Request URL");
    // Before Go answers, names aren't judged.
    expect(classes(url.contentDOM)).toContain("{{nope}} var-token var-pending");
    await waitFor(() =>
      expect(classes(url.contentDOM)).toEqual([
        "{{host}} var-token var-resolved",
        "{{nope}} var-token var-unresolved",
        "{{$guid}} var-token var-dynamic",
      ]),
    );

    await user.click(screen.getByRole("tab", { name: /^Headers/ }));
    const headers = screen.getByRole("table", { name: "Headers" });
    expect(classes(within(headers).getByRole("textbox", { name: "Value 1" }))).toEqual([
      "{{token}} var-token var-resolved",
    ]);

    await user.click(screen.getByRole("tab", { name: /^Auth/ }));
    expect(classes(screen.getByRole("textbox", { name: "Username" }))).toEqual([
      "{{host}} var-token var-resolved",
    ]);
    // The label focuses the field, which becomes an editor.
    await user.click(screen.getByText("Username"));
    expect(editorView("Username").hasFocus).toBe(true);
    typeInField("Username", "!");
    expect(activeTab().request.auth.username).toBe("{{host}}!");
    // One preview per draft change, shared by every editor.
    expect(vi.mocked(api.resolvePreview).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("shows the body's variables inside JSON strings", async () => {
    const user = userEvent.setup();
    resetTabs(
      {
        body: { ...activeTabBody(), type: "raw", language: "json", raw: '{"h": "{{host}}", "n": {{nope}}}' },
      },
      { parentId: "c1", workspaceId: "w1" },
    );
    render(
      <TooltipProvider>
        <RequestPane />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole("tab", { name: /^Body/ }));
    const body = editorView("Request body");
    await waitFor(() =>
      expect(classes(body.contentDOM)).toEqual([
        "{{host}} var-token var-resolved",
        "{{nope}} var-token var-unresolved",
      ]),
    );
  });
});

function activeTabBody() {
  resetTabs();
  return activeTab().request.body;
}

describe("variables in settings tabs", () => {
  it("marks references between an environment's rows, unsaved ones included", async () => {
    const dev = makeEnv("e1", "Dev", [
      makeVar("base", "https://{{host}}"),
      makeVar("path", "{{base}}/{{gone}}"),
    ]);
    useEnvironmentsStore.setState({
      status: "ready",
      workspaceId: "w1",
      environments: [dev],
      selectedId: "",
    });
    vi.mocked(api.getEnvironment).mockResolvedValue(dev);
    vi.mocked(api.visibleVariables).mockResolvedValue({
      variables: [makePreviewVar("host", "g", { scope: "global", scopeName: "Globals" })],
      environment: { id: "e1", name: "Dev" },
    });
    resetTabs();
    act(() => useTabsStore.getState().openDoc("environment", "e1", "Dev", "w1"));
    const tab = useTabsStore.getState().tabs.find((t) => t.doc)!;
    function Live() {
      const t = useTabsStore((s) => s.tabs.find((x) => x.id === tab.id)!);
      return <DocEditor tab={t} />;
    }
    render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    );
    const value2 = await screen.findByRole("textbox", { name: "Value 2" });
    await waitFor(() =>
      expect(classes(value2)).toEqual([
        "{{base}} var-token var-resolved",
        "{{gone}} var-token var-unresolved",
      ]),
    );
    expect(api.visibleVariables).toHaveBeenCalledWith("", "e1");
    // Adding the missing variable as a new row resolves it before saving.
    const key = screen.getByRole("textbox", { name: "Variable 3" });
    await userEvent.setup().type(key, "gone");
    await waitFor(() =>
      expect(classes(screen.getByRole("textbox", { name: "Value 2" }))).toEqual([
        "{{base}} var-token var-resolved",
        "{{gone}} var-token var-resolved",
      ]),
    );
    expect(fieldText("Value 2")).toBe("{{base}}/{{gone}}");
  });
});
