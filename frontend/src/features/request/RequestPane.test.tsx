import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { emptyBody } from "@/lib/model";
import { editorText, setEditorText } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { useTabsStore } from "@/stores/tabs";
import { RequestPane } from "./RequestPane";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function renderPane() {
  return render(
    <TooltipProvider>
      <RequestPane />
    </TooltipProvider>,
  );
}

const section = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("RequestPane", () => {
  beforeEach(() => resetTabs());

  it("syncs the URL into query and path params, and back", async () => {
    const user = userEvent.setup();
    renderPane();
    setEditorText("Request URL", "https://api.dev/users/:id?page=2&q=a%20b");
    const tab = activeTab().request;
    expect(tab.query).toEqual([
      { key: "page", value: "2", enabled: true },
      { key: "q", value: "a b", enabled: true },
    ]);
    expect(tab.pathParams).toEqual([{ key: "id", value: "", enabled: true }]);
    expect(section("Params")).toHaveTextContent("3");

    // Edit a value in the table: the URL is rewritten.
    const query = screen.getByRole("table", { name: "Query parameters" });
    const page = within(query).getByRole("textbox", { name: "Value 1" });
    await user.clear(page);
    await user.type(page, "5");
    expect(editorText("Request URL")).toBe("https://api.dev/users/:id?page=5&q=a%20b");

    // Disabling a row drops it from the URL but keeps it in place.
    await user.click(within(query).getByRole("checkbox", { name: "Enable row 1" }));
    expect(editorText("Request URL")).toBe("https://api.dev/users/:id?q=a%20b");
    expect(activeTab().request.query[0]).toMatchObject({ key: "page", enabled: false });

    // Path params are editable by value only.
    const path = screen.getByRole("table", { name: "Path parameters" });
    expect(within(path).getByRole("textbox", { name: "Name 1" })).toHaveAttribute("readonly");
    await user.type(within(path).getByRole("textbox", { name: "Value 1" }), "42");
    expect(activeTab().request.pathParams[0].value).toBe("42");
  });

  it("adds, deletes and pastes rows in the key/value table", async () => {
    const user = userEvent.setup();
    renderPane();
    const query = () => screen.getByRole("table", { name: "Query parameters" });
    await user.type(within(query()).getByRole("textbox", { name: "Key 1" }), "a");
    expect(activeTab().request.query).toEqual([{ key: "a", value: "", enabled: true }]);
    await user.type(within(query()).getByRole("textbox", { name: "Value 2" }), "v");
    expect(activeTab().request.query[1]).toEqual({ key: "", value: "v", enabled: true });

    await user.click(within(query()).getByRole("button", { name: "Delete row 2" }));
    expect(activeTab().request.query).toHaveLength(1);

    fireEvent.paste(within(query()).getByRole("textbox", { name: "Key 1" }), {
      clipboardData: { getData: () => "x=1&y=2" },
    });
    expect(activeTab().request.query.map((r) => r.key)).toEqual(["x", "y"]);

    // Plain text pastes normally.
    const evt = fireEvent.paste(within(query()).getByRole("textbox", { name: "Key 1" }), {
      clipboardData: { getData: () => "plain" },
    });
    expect(evt).toBe(true);

    // Enter moves between cells.
    within(query()).getByRole("textbox", { name: "Key 1" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(query()).getByRole("textbox", { name: "Value 1" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(within(query()).getByRole("textbox", { name: "Key 2" })).toHaveFocus());
  });

  it("edits headers as a table and as text, and lists auto headers", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://api.dev:8443/x", auth: { ...activeTab().request.auth, type: "basic" } });
    renderPane();
    await user.click(section("Headers"));
    await waitFor(() => expect(api.buildInfo).toHaveBeenCalled());

    const auto = screen.getByRole("list", { name: "Headers added when sending" });
    expect(within(auto).getByText("api.dev:8443")).toBeInTheDocument();
    await waitFor(() => expect(within(auto).getByText("Pakpos/test")).toBeInTheDocument());
    expect(within(auto).getByText("Authorization")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Header 1" }), "Authorization");
    expect(within(auto).getByText("Authorization").closest("li")).toHaveClass("line-through");
    expect(section("Headers")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Edit as text" }));
    const text = screen.getByRole("textbox", { name: "Headers as text" });
    expect(text).toHaveValue("Authorization: ");
    await user.clear(text);
    await user.type(text, "A: 1{Enter}//B: 2");
    expect(activeTab().request.headers).toEqual([
      { key: "A", value: "1", enabled: true },
      { key: "B", value: "2", enabled: false },
    ]);
    await user.click(screen.getByRole("button", { name: "Edit as table" }));
    expect(screen.getByRole("table", { name: "Headers" })).toBeInTheDocument();
  });

  it("switches body types and edits each kind", async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(section("Body"));
    expect(screen.getByText("This request has no body.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Raw" }));
    expect(section("Body")).toContainElement(screen.getByLabelText("has body"));
    setEditorText("Request body", '{"a":1}');
    expect(activeTab().request.body.raw).toBe('{"a":1}');
    await user.click(screen.getByRole("button", { name: "Beautify" }));
    expect(activeTab().request.body.raw).toBe('{\n  "a": 1\n}');

    setEditorText("Request body", "{bad");
    await user.click(screen.getByRole("button", { name: "Beautify" }));
    expect(toast.error).toHaveBeenCalledWith("The body isn't valid JSON", expect.anything());

    await user.click(screen.getByRole("combobox", { name: "Body language" }));
    await user.click(screen.getByRole("option", { name: "XML" }));
    setEditorText("Request body", "<a><b>1</b></a>");
    await user.click(screen.getByRole("button", { name: "Beautify" }));
    expect(activeTab().request.body.raw).toBe("<a>\n  <b>1</b>\n</a>");
    await user.click(screen.getByRole("combobox", { name: "Body language" }));
    await user.click(screen.getByRole("option", { name: "Text" }));
    expect(screen.queryByRole("button", { name: "Beautify" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "URL-encoded" }));
    await user.type(screen.getByRole("textbox", { name: "Key 1" }), "k");
    expect(activeTab().request.body.urlEncoded).toEqual([{ key: "k", value: "", enabled: true }]);

    vi.mocked(api.pickFile).mockResolvedValue("/home/me/photo.png");
    await user.click(screen.getByRole("radio", { name: "Binary file" }));
    await user.click(screen.getByRole("button", { name: "Choose file for binary body" }));
    await waitFor(() => expect(activeTab().request.body.binaryPath).toBe("/home/me/photo.png"));
    expect(screen.getByText("photo.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove file for binary body" }));
    expect(activeTab().request.body.binaryPath).toBe("");

    vi.mocked(api.pickFile).mockResolvedValue("");
    await user.click(screen.getByRole("button", { name: "Choose file for binary body" }));
    expect(activeTab().request.body.binaryPath).toBe("");
  });

  it("edits form-data text and file fields", async () => {
    const user = userEvent.setup();
    resetTabs({ body: { ...emptyBody(), type: "form-data" } });
    renderPane();
    await user.click(section("Body"));
    const table = () => screen.getByRole("table", { name: "Form fields" });
    await user.type(within(table()).getByRole("textbox", { name: "Key 1" }), "name");
    await user.type(within(table()).getByRole("textbox", { name: "Value 1" }), "Ada");
    expect(activeTab().request.body.formData[0]).toMatchObject({ key: "name", value: "Ada", kind: "text" });

    await user.click(within(table()).getByRole("checkbox", { name: "Enable field 1" }));
    expect(activeTab().request.body.formData[0].enabled).toBe(false);

    await user.click(within(table()).getByRole("combobox", { name: "Type of field 1" }));
    await user.click(screen.getByRole("option", { name: "File" }));
    vi.mocked(api.pickFile).mockResolvedValue("C:\\files\\cv.pdf");
    await user.click(within(table()).getByRole("button", { name: "Choose file for field 1" }));
    await waitFor(() => expect(activeTab().request.body.formData[0].filePath).toBe("C:\\files\\cv.pdf"));
    expect(within(table()).getByText("cv.pdf")).toBeInTheDocument();

    await user.click(within(table()).getByRole("button", { name: "Delete field 1" }));
    expect(activeTab().request.body.formData).toEqual([]);
  });

  it("edits every auth type", async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(section("Auth"));
    expect(screen.getByText("No authorization is sent.")).toBeInTheDocument();

    const pick = async (label: string) => {
      await user.click(screen.getByRole("combobox", { name: "Type" }));
      await user.click(screen.getByRole("option", { name: label }));
    };

    await pick("Inherit from parent");
    expect(screen.getByText(/isn't in a collection, so there's nothing to inherit/)).toBeInTheDocument();

    await pick("Basic auth");
    await user.type(screen.getByLabelText("Username"), "ada");
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await user.type(pw, "s3cret");
    await user.click(screen.getByRole("button", { name: "Show value" }));
    expect(pw).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide value" }));
    expect(activeTab().request.auth).toMatchObject({ type: "basic", username: "ada", password: "s3cret" });

    await pick("Bearer token");
    await user.type(screen.getByLabelText("Token"), "tok");
    await user.type(screen.getByLabelText("Prefix"), "Token");
    expect(activeTab().request.auth).toMatchObject({ token: "tok", prefix: "Token" });

    await pick("API key");
    await user.type(screen.getByLabelText("Key"), "X-Key");
    await user.type(screen.getByLabelText("Value"), "v");
    await user.click(screen.getByRole("combobox", { name: "Send in" }));
    await user.click(screen.getByRole("option", { name: "Query parameter" }));
    expect(activeTab().request.auth).toMatchObject({ apiKey: "X-Key", apiValue: "v", apiIn: "query" });
    expect(screen.getByText(/takes priority/)).toBeInTheDocument();
  });

  it("shows Cancel while sending", async () => {
    const user = userEvent.setup();
    resetTabs({ url: "https://x" }, { sendId: "s1" });
    renderPane();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancel).toHaveBeenCalledWith("s1");
    useTabsStore.getState().setResult("t1", null);
    expect(await screen.findByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("joins pasted multi-line URLs into one line", () => {
    renderPane();
    setEditorText("Request URL", "https://a.dev/x\n  ?y=1");
    expect(editorText("Request URL")).toBe("https://a.dev/x?y=1");
  });
});
