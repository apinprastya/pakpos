import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RequestPane } from "@/features/request/RequestPane";
import { ResponsePane } from "@/features/response/ResponsePane";
import { sendTab } from "@/features/request/actions";
import { api } from "@/lib/api";
import { emptyRequest, exampleToResponse, statusName, type Request, type SendResult } from "@/lib/model";
import { useExamplesStore } from "@/stores/examples";
import { useWorkspaceStore } from "@/stores/workspace";
import { editorText } from "@/test/editor";
import {
  col,
  makeExample,
  makeExampleSummary,
  savedExample,
  makeResponse,
  makeResult,
  req,
} from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { saveExampleState, savedLabel, TOO_LARGE } from "./saveState";
import { useExamplesSync } from "./useExamplesSync";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } };
});

const ws = { id: "w1", name: "Shop", path: "/shop" };
const saved: Request = { ...emptyRequest(), id: "r1", name: "List users", url: "https://api/users" };
const ok = (patch = {}, historyId = 7): SendResult =>
  makeResult({ response: makeResponse(patch), historyId });

function Sync() {
  useExamplesSync();
  return null;
}

function renderPanes() {
  return render(
    <TooltipProvider>
      <Sync />
      <RequestPane />
      <ResponsePane />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useWorkspaceStore.setState({
    status: "ready",
    workspace: ws,
    collections: [col("c1", "Users", [req("r1")])],
  });
});

describe("saveExampleState", () => {
  const tab = (patch = {}) => ({ ...resetTabs(saved, { saved, ...patch }) });
  it.each([
    ["no result", {}, "There's no response to save."],
    [
      "an error",
      { result: makeResult({ error: { kind: "dns", message: "x" }, historyId: 3 }) },
      "There's no response to save.",
    ],
    ["a truncated body", { result: ok({ truncated: true }) }, TOO_LARGE],
    ["a body over 1 MB", { result: ok({ size: (1 << 20) + 1 }) }, TOO_LARGE],
    [
      "no history entry",
      { result: ok({}, 0) },
      "This response wasn't recorded. Send the request again to save it.",
    ],
  ])("refuses %s", (_, patch, reason) => {
    expect(saveExampleState(tab(patch))).toEqual({ ok: false, reason });
  });

  it("refuses an unsaved request and names a saveable response by its status", () => {
    expect(saveExampleState(resetTabs({}, { result: ok() }))).toEqual({
      ok: false,
      reason: "Save the request first.",
    });
    expect(saveExampleState(tab({ result: ok({ statusCode: 201, statusText: "Created" }) }))).toEqual({
      ok: true,
      defaultName: "201 Created",
    });
  });

  it("formats status names and saved dates", () => {
    expect(statusName(200, "200 OK")).toBe("200 OK");
    expect(statusName(404, "Not Found")).toBe("404 Not Found");
    expect(statusName(204, "")).toBe("204");
    expect(statusName(0, "")).toBe("");
    expect(statusName(0, "weird")).toBe("weird");
    expect(savedLabel("not a date")).toBe("");
    expect(savedLabel("2025-01-02T03:04:00Z", new Date("2026-06-01T00:00:00Z"))).toMatch(/2025/);
    expect(savedLabel("2026-01-02T03:04:00Z", new Date("2026-06-01T00:00:00Z"))).not.toMatch(/2026/);
  });

  it("shapes an example's response for the viewers", () => {
    const r = exampleToResponse(makeExample("x").response);
    expect(r).toMatchObject({ url: "", cookies: [], truncated: false, bodyPath: "", statusCode: 200 });
  });
});

describe("save as example", () => {
  it("saves the response under a name, defaulting to the status", async () => {
    const user = userEvent.setup();
    resetTabs(saved, { saved, result: ok() });
    vi.mocked(api.saveExample).mockResolvedValue(
      savedExample(makeExampleSummary("x1", "r1", { name: "Users page" })),
    );
    vi.mocked(api.listAllExamples).mockResolvedValue([
      makeExampleSummary("x1", "r1", { name: "Users page" }),
    ]);
    renderPanes();
    await user.click(screen.getByRole("button", { name: "Save as example" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as example" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("200 OK");
    await user.clear(name);
    await user.click(within(dialog).getByRole("button", { name: "Save example" })); // empty: disabled
    expect(api.saveExample).not.toHaveBeenCalled();
    await user.type(name, "Users page{Enter}");
    expect(api.saveExample).toHaveBeenCalledWith("r1", "Users page", 7, false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /Examples/ })).toHaveTextContent("1");
  });

  it("keeps the dialog open when saving fails, and cancels", async () => {
    const user = userEvent.setup();
    resetTabs(saved, { saved, result: ok() });
    vi.mocked(api.saveExample).mockRejectedValue(new Error("disk full"));
    renderPanes();
    await user.click(screen.getByRole("button", { name: "Save as example" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as example" });
    await user.click(within(dialog).getByRole("button", { name: "Save example" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the example", { description: "disk full" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("explains why it can't save an unsaved request or an error", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://x" }, { result: ok() });
    const { unmount } = renderPanes();
    const button = screen.getByRole("button", { name: "Save as example" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => button.blur());
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Save the request first.");
    unmount();

    resetTabs(saved, {
      saved,
      result: makeResult({ error: { kind: "dns", message: "no host" }, historyId: 2 }),
    });
    renderPanes();
    expect(screen.getByRole("button", { name: "Save as example" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("examples list and viewer", () => {
  async function withExamples() {
    vi.mocked(api.listAllExamples).mockResolvedValue([
      makeExampleSummary("x1", "r1", { name: "200 OK" }),
      makeExampleSummary("x2", "r1", {
        name: "Unauthorized",
        statusCode: 401,
        statusText: "401 Unauthorized",
      }),
    ]);
    vi.mocked(api.getExample).mockImplementation(async (_r, id) =>
      makeExample(id, {
        name: id === "x2" ? "Unauthorized" : "200 OK",
        response: { ...makeExample(id).response, body: id === "x2" ? '{"error":"no"}' : '{"ok":true}' },
      }),
    );
  }

  it("asks to save the request first, or explains how to add examples", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://x" });
    const { unmount } = renderPanes();
    await user.click(screen.getByRole("tab", { name: /Examples/ }));
    expect(screen.getByText(/Save the request to keep examples/)).toBeInTheDocument();
    unmount();
    resetTabs(saved, { saved });
    renderPanes();
    await user.click(screen.getByRole("tab", { name: /Examples/ }));
    expect(screen.getByText(/No examples yet/)).toBeInTheDocument();
  });

  it("opens an example read-only in the response pane and goes back to the last response", async () => {
    const user = userEvent.setup();
    await withExamples();
    resetTabs(saved, { saved, result: ok({ body: '{"live":1}' }) });
    renderPanes();
    await user.click(screen.getByRole("tab", { name: /Examples/ }));
    const list = await screen.findByRole("list", { name: "Examples" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("401")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Open example Unauthorized" }));
    const banner = await screen.findByRole("note", { name: "Example: Unauthorized" });
    expect(banner).toHaveTextContent("saved");
    expect(within(list).getByRole("button", { name: "Open example Unauthorized" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(editorText("Response body")).toContain('"error"');
    expect(screen.getByLabelText("Status 200 OK")).toBeInTheDocument();
    const response = screen.getByRole("region", { name: "Response" });
    await user.click(within(response).getByRole("tab", { name: /Headers/ }));
    expect(within(response).getByText("Content-Type")).toBeInTheDocument();
    await user.click(within(response).getByRole("tab", { name: "Body" }));

    await user.click(within(banner).getByRole("button", { name: "Back to last response" }));
    expect(screen.queryByRole("note", { name: /Example:/ })).not.toBeInTheDocument();
    expect(editorText("Response body")).toContain("live");
  });

  it("says Close example when the tab has no response, and a send replaces the example", async () => {
    const user = userEvent.setup();
    await withExamples();
    resetTabs(saved, { saved });
    renderPanes();
    await act(() => useExamplesStore.getState().show("t1", "r1", "x1"));
    expect(screen.getByRole("button", { name: "Close example" })).toBeInTheDocument();
    vi.mocked(api.send).mockResolvedValue(ok());
    await act(() => sendTab("t1"));
    expect(screen.queryByRole("note", { name: /Example:/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save as example" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("renames inline and deletes with a confirm", async () => {
    const user = userEvent.setup();
    await withExamples();
    vi.mocked(api.renameExample).mockResolvedValue(makeExampleSummary("x1", "r1", { name: "Happy path" }));
    resetTabs(saved, { saved });
    renderPanes();
    await user.click(screen.getByRole("tab", { name: /Examples/ }));
    const list = await screen.findByRole("list", { name: "Examples" });

    await user.click(within(list).getByRole("button", { name: "Rename example 200 OK" }));
    const input = await within(list).findByRole("textbox", { name: "Example name" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "Happy path{Enter}");
    expect(api.renameExample).toHaveBeenCalledWith("r1", "x1", "Happy path");

    // Double-click also renames; Escape cancels.
    await user.dblClick(within(list).getByRole("button", { name: "Open example Unauthorized" }));
    const again = await within(list).findByRole("textbox", { name: "Example name" });
    await user.type(again, "{Escape}");
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();

    await act(() => useExamplesStore.getState().show("t1", "r1", "x2"));
    await user.click(within(list).getByRole("button", { name: "Delete example Unauthorized" }));
    const confirm = await screen.findByRole("alertdialog", { name: 'Delete example "Unauthorized"?' });
    vi.mocked(api.listAllExamples).mockResolvedValue([makeExampleSummary("x1", "r1")]);
    await user.click(within(confirm).getByRole("button", { name: "Delete example" }));
    expect(api.deleteExample).toHaveBeenCalledWith("r1", "x2");
    expect(useExamplesStore.getState().viewing.t1).toBeUndefined();
  });

  it("reloads the cache when the tree or the workspace changes", async () => {
    vi.mocked(api.listAllExamples).mockResolvedValue([makeExampleSummary("x1", "r1")]);
    resetTabs(saved, { saved });
    renderPanes();
    await waitFor(() => expect(useExamplesStore.getState().byRequest.r1).toHaveLength(1));
    vi.mocked(api.listAllExamples).mockResolvedValue([]);
    act(() => useWorkspaceStore.setState({ collections: [col("c1", "Users", [req("r1")])] }));
    await waitFor(() => expect(useExamplesStore.getState().byRequest.r1).toBeUndefined());
    const calls = vi.mocked(api.listAllExamples).mock.calls.length;
    act(() => useWorkspaceStore.setState({ problems: [] })); // unrelated change
    expect(vi.mocked(api.listAllExamples).mock.calls.length).toBe(calls);
    act(() => useWorkspaceStore.setState({ workspace: null }));
    await waitFor(() => expect(useExamplesStore.getState().workspaceId).toBeNull());
  });
});

describe("save as example: secret values in the response", () => {
  async function openDialog() {
    const user = userEvent.setup();
    resetTabs(saved, { saved, result: ok() });
    renderPanes();
    await user.click(screen.getByRole("button", { name: "Save as example" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as example" });
    await user.click(within(dialog).getByRole("button", { name: "Save example" }));
    return user;
  }

  it("warns about one secret and saves with {{name}} instead", async () => {
    vi.mocked(api.saveExample)
      .mockResolvedValueOnce({ example: null, secretsFound: ["token"], secretsLocked: false })
      .mockResolvedValueOnce(savedExample(makeExampleSummary("x1", "r1")));
    const user = await openDialog();
    const warning = await screen.findByRole("dialog", { name: "The response contains a secret" });
    expect(warning).toHaveAccessibleDescription(
      "This response contains the value of {{token}}. Examples are saved in the workspace and may be committed.",
    );
    expect(within(warning).queryByRole("list")).not.toBeInTheDocument();
    await user.click(within(warning).getByRole("button", { name: "Save with {{token}} instead" }));
    expect(api.saveExample).toHaveBeenLastCalledWith("r1", "200 OK", 7, true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("lists several secrets and cancels without saving", async () => {
    vi.mocked(api.saveExample).mockResolvedValueOnce({
      example: null,
      secretsFound: ["token", "apiKey", "password"],
      secretsLocked: false,
    });
    const user = await openDialog();
    const warning = await screen.findByRole("dialog", { name: "The response contains a secret" });
    expect(warning).toHaveAccessibleDescription(/value of \{\{token\}\} \(and 2 more\)/);
    expect(
      within(warning)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["{{token}}", "{{apiKey}}", "{{password}}"]);
    expect(
      within(warning).getByRole("button", { name: "Save with {{variables}} instead" }),
    ).toBeInTheDocument();
    await user.click(within(warning).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.saveExample).toHaveBeenCalledTimes(1);
  });
});
