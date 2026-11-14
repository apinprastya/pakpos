import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/shell/Sidebar";
import { api } from "@/lib/api";
import { emptyRequest, normalizeRequest } from "@/lib/model";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useLayoutStore } from "@/stores/layout";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { editorText, editorView, setEditorText } from "@/test/editor";
import { col, folder, makeCodeResult, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { ImportCurlDialog } from "./ImportCurlDialog";
import { resetCodeLanguages } from "./languages";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  };
});

const imported = normalizeRequest({
  name: "POST /orders",
  method: "POST",
  url: "https://api.example.com/orders",
  headers: [
    { key: "Accept", value: "*/*", enabled: true },
    { key: "X-Off", value: "1", enabled: false },
  ],
  body: { type: "raw", language: "json", raw: '{"a":1}' },
  auth: { type: "bearer", token: "t" },
});

/** Pastes text into the CodeMirror editor named label. */
function paste(label: string, text: string) {
  const content = screen.getByRole("textbox", { name: label });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  act(() => {
    content.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  resetTabs();
  resetCodeLanguages();
  localStorage.clear();
});

describe("paste a curl command into the URL bar", () => {
  it("replaces the request, keeping the tab, and undo restores it", async () => {
    const saved = { ...emptyRequest(), id: "r1", name: "Orders", url: "https://old" };
    resetTabs(saved, { saved, parentId: "c1" });
    vi.mocked(api.importCurl).mockResolvedValue({ request: imported, warnings: [] });
    render(<App />);

    const event = paste("Request URL", "  curl https://api.example.com/orders -d '{}'");
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(activeTab().request.method).toBe("POST"));
    expect(activeTab().request).toMatchObject({ id: "r1", name: "Orders", url: imported.url });
    expect(activeTab().parentId).toBe("c1");
    await waitFor(() => expect(editorText("Request URL")).toBe(imported.url));
    expect(useTabsStore.getState().tabs).toHaveLength(1);

    const opts = vi.mocked(toast.success).mock.calls.at(-1)![1] as unknown as {
      action: { onClick: () => void };
    };
    act(() => opts.action.onClick());
    expect(activeTab().request).toEqual(saved);
  });

  it("leaves normal pastes to the editor", () => {
    render(<App />);
    paste("Request URL", "");
    paste("Request URL", "https://example.com/curl");
    expect(api.importCurl).not.toHaveBeenCalled();
    expect(editorText("Request URL")).toBe("https://example.com/curl");
  });
});

describe("Import cURL dialog", () => {
  it("opens from the new-tab menu, previews, warns and imports into a new tab", async () => {
    const user = userEvent.setup();
    vi.mocked(api.importCurl).mockResolvedValue({
      request: imported,
      warnings: [
        { option: "-k", message: "TLS is a setting." },
        { option: "", message: "Imported as JSON." },
      ],
    });
    render(<App />);
    await user.click(screen.getByRole("button", { name: "More ways to start a request" }));
    await user.click(await screen.findByRole("menuitem", { name: "Import cURL…" }));
    const dialog = await screen.findByRole("dialog", { name: "Import cURL" });
    expect(within(dialog).getByText("The request will show here as you paste.")).toBeInTheDocument();
    const importBtn = within(dialog).getByRole("button", { name: "Import" });
    expect(importBtn).toBeDisabled();

    setEditorText("cURL command", "curl -k https://api.example.com/orders");
    const preview = await within(dialog).findByRole("region", { name: "Preview" });
    expect(within(preview).getByText("POST")).toBeInTheDocument();
    expect(within(preview).getByText(imported.url)).toBeInTheDocument();
    expect(within(preview).getByText("1: Accept")).toBeInTheDocument();
    expect(within(preview).getByText("JSON · 7 characters")).toBeInTheDocument();
    expect(within(preview).getByText("Bearer token")).toBeInTheDocument();
    expect(within(preview).getByText("POST /orders")).toBeInTheDocument();
    const warnings = within(preview).getByRole("list", { name: "Warnings" });
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(2);
    expect(within(preview).getByText("2 warnings")).toBeInTheDocument();

    await user.click(importBtn);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(activeTab()).toMatchObject({ saved: null, parentId: "" });
    expect(activeTab().request).toMatchObject({ url: imported.url, name: "POST /orders" });
  });

  it("the new-tab menu also opens a blank request", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "More ways to start a request" }));
    await user.click(await screen.findByRole("menuitem", { name: /New request/ }));
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });

  it("shows parse errors, clears with the text, and cancels", async () => {
    const user = userEvent.setup();
    vi.mocked(api.importCurl).mockRejectedValue(new Error("A quote in the command isn't closed."));
    render(<App />);
    act(() => useCodeDialogsStore.getState().openImport());
    const dialog = await screen.findByRole("dialog", { name: "Import cURL" });
    setEditorText("cURL command", "curl 'x");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A quote in the command isn't closed.",
    );
    setEditorText("cURL command", "  ");
    expect(within(dialog).getByText("The request will show here as you paste.")).toBeInTheDocument();
    vi.mocked(api.importCurl).mockRejectedValue("plain failure");
    setEditorText("cURL command", "curl y");
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("plain failure"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(useCodeDialogsStore.getState().importOpen).toBe(false));
  });

  it("previews a single warning, basic auth and no headers", async () => {
    vi.mocked(api.importCurl).mockResolvedValue({
      request: normalizeRequest({ method: "GET", url: "https://a", auth: { type: "basic", username: "u" } }),
      warnings: [{ option: "", message: "Only one." }],
    });
    render(<App />);
    act(() => useCodeDialogsStore.getState().openImport());
    const dialog = await screen.findByRole("dialog", { name: "Import cURL" });
    setEditorText("cURL command", "curl -u u https://a");
    const preview = await within(dialog).findByRole("region", { name: "Preview" });
    expect(within(preview).getByText("1 warning")).toBeInTheDocument();
    expect(within(preview).getByText("Untitled request")).toBeInTheDocument();
    expect(within(preview).getByText("None")).toBeInTheDocument();
    expect(within(preview).getByText("Basic auth as u")).toBeInTheDocument();
  });
});

describe("tree menus", () => {
  const ws = { id: "w1", name: "Shop", path: "/shop" };
  const cols = [col("c1", "Users", [folder("f1", "Admin"), req("r1", "List users")])];

  function renderTree() {
    vi.mocked(api.tree).mockResolvedValue({ collections: cols, problems: [] });
    useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: cols, problems: [] });
    useLayoutStore.setState({ sidebarView: "collections" });
    return render(
      <TooltipProvider>
        <Sidebar />
        <ImportCurlDialog />
      </TooltipProvider>,
    );
  }

  it("imports into a folder as a new draft with that parent", async () => {
    const user = userEvent.setup();
    vi.mocked(api.importCurl).mockResolvedValue({ request: imported, warnings: [] });
    renderTree();
    fireEvent.contextMenu(within(screen.getByRole("tree", { name: "Collections" })).getByText("Admin"));
    await user.click(await screen.findByRole("menuitem", { name: "Import cURL here" }));
    const dialog = await screen.findByRole("dialog", { name: "Import cURL into Admin" });
    setEditorText("cURL command", "curl https://api.example.com/orders");
    await within(dialog).findByRole("region", { name: "Preview" });
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(activeTab().parentId).toBe("f1"));
    expect(activeTab().saved).toBeNull();
  });

  it("copies a request as cURL from its menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(api.getRequest).mockResolvedValue({ ...emptyRequest(), id: "r1", url: "https://a" });
    vi.mocked(api.generateCode).mockResolvedValue(makeCodeResult({ code: "curl https://a" }));
    renderTree();
    const row = await within(screen.getByRole("tree", { name: "Collections" })).findByText("List users");
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole("menuitem", { name: "Copy as cURL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("curl https://a"));
    expect(api.generateCode).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), "c1", "curl", {
      resolveVariables: true,
      revealSecrets: false,
    });
  });
});

describe("Generate code dialog", () => {
  const langs = [
    { id: "curl", label: "cURL", editor: "shell" },
    { id: "python-requests", label: "Python (requests)", editor: "python" },
  ];

  beforeEach(() => {
    vi.mocked(api.codeLanguages).mockResolvedValue(langs);
    vi.mocked(api.generateCode).mockImplementation(async (_r, _p, lang, opts) =>
      makeCodeResult({
        code: `${lang} ${opts.resolveVariables ? "resolved" : "as-written"} ${opts.revealSecrets ? "s3cret" : "{{token}}"}`,
        masked: opts.revealSecrets || !opts.resolveVariables ? [] : ["token"],
        unresolved: ["host"],
        warnings: lang === "python-requests" ? ["requests joined headers."] : [],
      }),
    );
  });

  it("opens from the request toolbar, regenerates on option changes and copies", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    resetTabs({ url: "https://{{host}}/me" }, { parentId: "c1" });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate code" }));
    const dialog = await screen.findByRole("dialog", { name: "Generate code" });
    await waitFor(() => expect(editorText("Generated code")).toBe("curl resolved {{token}}"));
    expect(api.generateCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://{{host}}/me" }),
      "c1",
      "curl",
      {
        resolveVariables: true,
        revealSecrets: false,
      },
    );
    const notes = within(dialog).getByRole("note", { name: "Notes" });
    expect(notes).toHaveTextContent("Secrets are shown as {{token}}.");
    expect(notes).toHaveTextContent("No value for {{host}}");
    expect(notes).toHaveTextContent("the command uses curl's defaults.");

    // Reveal secrets: warning, then the value.
    const reveal = within(dialog).getByRole("switch", { name: "Reveal secrets" });
    expect(reveal).not.toBeChecked();
    await user.click(reveal);
    expect(within(dialog).getByRole("status")).toHaveTextContent("Secret values are in the code below.");
    await waitFor(() => expect(editorText("Generated code")).toBe("curl resolved s3cret"));

    // Resolving off disables (and turns off) reveal.
    await user.click(within(dialog).getByRole("switch", { name: "Resolve variables" }));
    expect(within(dialog).getByRole("switch", { name: "Reveal secrets" })).toBeDisabled();
    expect(within(dialog).getByRole("switch", { name: "Reveal secrets" })).not.toBeChecked();
    await waitFor(() => expect(editorText("Generated code")).toBe("curl as-written {{token}}"));
    expect(api.generateCode).toHaveBeenLastCalledWith(expect.anything(), "c1", "curl", {
      resolveVariables: false,
      revealSecrets: false,
    });

    // Another language is remembered.
    await user.click(within(dialog).getByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "Python (requests)" }));
    await waitFor(() => expect(editorText("Generated code")).toBe("python-requests as-written {{token}}"));
    expect(localStorage.getItem("pakpos-code-language")).toBe("python-requests");
    expect(within(dialog).getByRole("note", { name: "Notes" })).toHaveTextContent("requests joined headers.");
    expect(within(dialog).getByRole("note", { name: "Notes" })).toHaveTextContent(
      "Pakpos also sends User-Agent and Accept-Encoding; the generated code uses the library's defaults.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("python-requests as-written {{token}}");
    expect(toast.success).toHaveBeenCalledWith("Code copied");

    writeText.mockRejectedValue(new Error("no"));
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the code", {
      description: "The clipboard isn't available.",
    });

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useCodeDialogsStore.getState().codeTabId).toBeNull());
  });

  it("drops revealed secrets when it closes", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://a" });
    render(<App />);
    act(() => useCodeDialogsStore.getState().openCode("t1"));
    let dialog = await screen.findByRole("dialog", { name: "Generate code" });
    await user.click(within(dialog).getByRole("switch", { name: "Reveal secrets" }));
    await waitFor(() => expect(editorText("Generated code")).toContain("s3cret"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    act(() => useCodeDialogsStore.getState().openCode("t1"));
    dialog = await screen.findByRole("dialog", { name: "Generate code" });
    expect(within(dialog).getByRole("switch", { name: "Reveal secrets" })).not.toBeChecked();
    await waitFor(() => expect(editorText("Generated code")).toBe("curl resolved {{token}}"));
  });

  it("opens with the shortcut on request tabs only, and from the More menu", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://a" });
    render(<App />);
    await user.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
    expect(useCodeDialogsStore.getState().codeTabId).toBe("t1");
    await screen.findByRole("dialog", { name: "Generate code" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useCodeDialogsStore.getState().codeTabId).toBeNull());

    // Other Shift shortcuts do nothing.
    await user.keyboard("{Control>}{Shift>}x{/Shift}{/Control}");
    expect(useCodeDialogsStore.getState().codeTabId).toBeNull();

    await user.click(screen.getByRole("button", { name: "More request actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Generate code/ }));
    expect(useCodeDialogsStore.getState().codeTabId).toBe("t1");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useCodeDialogsStore.getState().codeTabId).toBeNull());

    act(() => {
      useTabsStore.getState().openDoc("globals", "", "", "");
    });
    await user.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
    expect(useCodeDialogsStore.getState().codeTabId).toBeNull();
  });

  it("copies as cURL from the More menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    resetTabs({ url: "https://a" });
    render(<App />);
    await user.click(screen.getByRole("button", { name: "More request actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy as cURL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("curl resolved {{token}}"));
  });

  it("shows generation and language errors", async () => {
    resetTabs({ url: "https://a" });
    vi.mocked(api.generateCode).mockRejectedValue(new Error("Variables refer to each other in a loop."));
    render(<App />);
    act(() => useCodeDialogsStore.getState().openCode("t1"));
    const dialog = await screen.findByRole("dialog", { name: "Generate code" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("loop");
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeDisabled();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    resetCodeLanguages();
    vi.mocked(api.codeLanguages).mockRejectedValueOnce("offline");
    act(() => useCodeDialogsStore.getState().openCode("t1"));
    const again = await screen.findByRole("dialog", { name: "Generate code" });
    expect(await within(again).findByRole("alert")).toHaveTextContent("offline");
  });

  it("falls back to the first language when the remembered one is gone", async () => {
    useCodeDialogsStore.setState({ language: "cobol" });
    resetTabs({ url: "https://a" });
    render(<App />);
    act(() => useCodeDialogsStore.getState().openCode("t1"));
    await screen.findByRole("dialog", { name: "Generate code" });
    await waitFor(() => expect(editorText("Generated code")).toBe("curl resolved {{token}}"));
    expect(editorView("Generated code").state.readOnly).toBe(true);
  });
});
