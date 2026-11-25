import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Response, SendResult } from "@/lib/model";
import { editorText, editorView } from "@/test/editor";
import { makeHop, makeResponse, makeResult } from "@/test/fixtures";
import { debugText } from "./debugText";
import { resetTabs } from "@/test/store";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useTabsStore } from "@/stores/tabs";
import { ResponsePane } from "./ResponsePane";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function show(result: SendResult | null, sendId: string | null = null) {
  resetTabs({ url: "https://x" }, { result, sendId });
  return render(
    <TooltipProvider>
      <ResponsePane />
    </TooltipProvider>,
  );
}

const ok = (patch: Partial<Response> = {}, historyId = 5): SendResult =>
  makeResult({ response: makeResponse(patch), historyId });

describe("ResponsePane", () => {
  it("shows the empty state, noting a workspace is only needed to save", () => {
    show(null);
    expect(screen.getByText(/send the request to see the response/)).toBeInTheDocument();
    expect(screen.getByText(/You can send requests without a workspace/)).toBeInTheDocument();
  });

  it("drops the workspace note when one is open", () => {
    useWorkspaceStore.setState({ workspace: { id: "w", name: "W", path: "/w" } });
    show(null);
    expect(screen.queryByText(/without a workspace/)).not.toBeInTheDocument();
  });

  it.each([
    ["tls", "network"],
    ["proxy", "network"],
    ["timeout", "requests"],
    ["too_many_redirects", "requests"],
  ])("offers Open settings for %s errors", async (kind, section) => {
    const user = userEvent.setup();
    show(makeResult({ response: null, error: { kind: kind as never, message: "x" }, historyId: 1 }));
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useSettingsStore.getState()).toMatchObject({ dialogOpen: true, section });
  });

  it("doesn't offer settings for errors settings can't fix", () => {
    show(makeResult({ response: null, error: { kind: "dns", message: "no such host" }, historyId: 1 }));
    expect(screen.queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument();
  });

  it("shows progress with a cancel button while sending", async () => {
    const user = userEvent.setup();
    show(null, "s1");
    expect(screen.getByRole("region", { name: "Response" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Sending request…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancel).toHaveBeenCalledWith("s1");
  });

  it("explains errors with a hint", () => {
    show(makeResult({ error: { kind: "dns", message: "lookup nope.invalid: no such host" } }));
    expect(screen.getByRole("heading", { name: "Couldn't find the server" })).toBeInTheDocument();
    expect(screen.getByText("lookup nope.invalid: no such host")).toBeInTheDocument();
    expect(screen.getByText(/Check the host name/)).toBeInTheDocument();
  });

  it("shows cancellation quietly", () => {
    show(
      makeResult({ response: null, error: { kind: "canceled", message: "context canceled" }, historyId: 0 }),
    );
    expect(screen.getByRole("heading", { name: "Request cancelled" })).toBeInTheDocument();
    expect(screen.queryByText("context canceled")).not.toBeInTheDocument();
  });

  it("shows status, time breakdown and size", async () => {
    const user = userEvent.setup();
    show(ok({ statusCode: 404, statusText: "404 Not Found", size: 2048 }));
    expect(screen.getByLabelText("Status 404 Not Found")).toHaveClass("text-status-client");
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /Time 123 ms/ }));
    expect(await screen.findByText("Where the time went")).toBeInTheDocument();
    expect(screen.getByText("DNS lookup")).toBeInTheDocument();
  });

  it("puts the code before a bare reason phrase, as Go sends it", () => {
    show(ok({ statusCode: 201, statusText: "Created" }));
    expect(screen.getByLabelText("Status 201 Created")).toBeInTheDocument();
  });

  it("notes reused connections and skipped phases", async () => {
    const user = userEvent.setup();
    show(
      ok({ timings: { dns: 0, connect: 0, tls: 0, ttfb: 4, total: 0, reusedConn: true }, statusText: "" }),
    );
    expect(screen.getByLabelText("Status 200")).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /Time 0 ms/ }));
    expect(await screen.findByText(/Reused an open connection/)).toBeInTheDocument();
  });

  it("pretty prints JSON, switches to raw, searches, copies and saves", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show(ok());
    expect(editorText("Response body")).toBe('{\n  "id": 42,\n  "name": "Ada"\n}');

    await user.click(screen.getByRole("radio", { name: "Raw" }));
    expect(editorText("Response body")).toBe('{"id":42,"name":"Ada"}');

    await user.click(screen.getByRole("button", { name: "Search in response" }));
    expect(editorView("Response body").dom.querySelector(".cm-search")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith('{"id":42,"name":"Ada"}');
    expect(toast.success).toHaveBeenCalledWith("Response copied");

    writeText.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy response" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the response", expect.anything());

    await user.click(screen.getByRole("button", { name: "Save response to file" }));
    expect(api.saveResponseBody).toHaveBeenCalledWith(5);
  });

  it("filters a JSON body with JSONPath, and keeps the filter for the next response", async () => {
    const user = userEvent.setup();
    // user-event reads [ and { as key names unless doubled.
    const typeText = (el: HTMLElement, text: string) => user.type(el, text.replace(/[[{]/g, "$&$&"));
    const body = '{"items":[{"id":1,"price":12345678901234567890},{"id":2,"price":3}]}';
    show(ok({ body, size: body.length }));
    await user.click(screen.getByRole("button", { name: "Filter with JSONPath" }));
    const field = screen.getByRole("textbox", { name: "JSONPath filter" });
    expect(field).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Type a JSONPath");

    await typeText(field, "$.items[*].price");
    await waitFor(() => expect(editorText("Response body")).toBe("[\n  12345678901234567890,\n  3\n]"));
    expect(screen.getByRole("status")).toHaveTextContent("2 matches");

    await user.clear(field);
    await typeText(field, "$.items[?@.id == 2]");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 match"));

    await typeText(field, "[");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Expected a name, an index"));
    expect(field).toHaveAttribute("aria-invalid", "true");
    // The last good result isn't shown; the body is.
    expect(editorText("Response body")).toContain('"items"');

    // A new response (same tab) keeps the filter.
    act(() => useTabsStore.getState().setResult("t1", ok({ body: '{"items":[]}' }, 6)));
    expect(await screen.findByRole("textbox", { name: "JSONPath filter" })).toHaveValue(
      "$.items[?@.id == 2][",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "JSONPath filter" })).not.toBeInTheDocument();
    expect(editorText("Response body")).toBe('{\n  "items": []\n}');
    expect(screen.getByRole("button", { name: "Filter with JSONPath" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("explains a JSON body that can't be filtered, and offers no filter for other bodies", async () => {
    const user = userEvent.setup();
    show(ok({ body: '{"cut": [1, 2', size: 13 }));
    await user.click(screen.getByRole("button", { name: "Filter with JSONPath" }));
    await user.type(screen.getByRole("textbox", { name: "JSONPath filter" }), "$");
    expect(screen.getByRole("status")).toHaveTextContent(
      "The body isn't valid JSON, so it can't be filtered.",
    );
    await user.click(screen.getByRole("button", { name: "Close filter" }));
    await user.click(screen.getByRole("radio", { name: "Raw" }));
    expect(screen.queryByRole("button", { name: "Filter with JSONPath" })).not.toBeInTheDocument();
  });

  it("copies a JSON field's value, key and path from the body's menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show(ok());
    const view = editorView("Response body");
    const openAt = (needle: string) => {
      const pos = view.state.doc.toString().indexOf(needle) + 1;
      act(() => view.dispatch({ selection: { anchor: pos } }));
      fireEvent.contextMenu(view.contentDOM); // keyboard-style: no pointer position
    };

    openAt('"Ada"');
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("name")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Copy selection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Copy value" }));
    expect(writeText).toHaveBeenLastCalledWith("Ada");
    expect(toast.success).toHaveBeenCalledWith("Value copied");

    openAt("42");
    await user.click(await screen.findByRole("menuitem", { name: "Copy key" }));
    expect(writeText).toHaveBeenLastCalledWith("id");
    openAt("42");
    await user.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenLastCalledWith("id");

    // The root has no key or path; select all, then copy the selection.
    openAt("{");
    expect(await screen.findByRole("menuitem", { name: "Copy value" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy key" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Select all" }));
    fireEvent.contextMenu(view.contentDOM, { clientX: 5, clientY: 5 });
    writeText.mockRejectedValue(new Error("denied"));
    await user.click(await screen.findByRole("menuitem", { name: "Copy selection" }));
    expect(writeText).toHaveBeenLastCalledWith(view.state.doc.toString());
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy", expect.anything());
  });

  it("offers only copy and select all for non-JSON bodies", async () => {
    show(ok({ kind: "text", contentType: "text/plain", body: "hello" }));
    fireEvent.contextMenu(editorView("Response body").contentDOM);
    expect(await screen.findByRole("menuitem", { name: "Select all" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy value" })).not.toBeInTheDocument();
  });

  it("opens the body, or the selection, in the JSON tool", async () => {
    const user = userEvent.setup();
    show(ok());
    const view = editorView("Response body");
    const body = view.state.doc.toString();
    fireEvent.contextMenu(view.contentDOM);
    await user.click(await screen.findByRole("menuitem", { name: "Open in JSON tool" }));
    const tools = () => useTabsStore.getState().tabs.filter((t) => t.tool?.id === "json");
    expect(tools()).toHaveLength(1);
    expect(tools()[0].tool?.state).toMatchObject({ input: body, mode: "format" });
    expect(useTabsStore.getState().activeId).toBe(tools()[0].id);
  });

  it("replaces the open JSON tool's input with the selection", async () => {
    const user = userEvent.setup();
    show(ok({ kind: "text", contentType: "text/plain", body: 'x {"a":1} y' }));
    act(() => {
      useTabsStore.getState().openTool("json", "old");
      useTabsStore.getState().activate("t1");
    });
    const tools = () => useTabsStore.getState().tabs.filter((t) => t.tool?.id === "json");
    const text = editorView("Response body");
    act(() => text.dispatch({ selection: { anchor: 2, head: 9 } }));
    fireEvent.contextMenu(text.contentDOM);
    await user.click(await screen.findByRole("menuitem", { name: "Open in JSON tool" }));
    expect(tools()).toHaveLength(1);
    expect(tools()[0].tool?.state).toMatchObject({ input: '{"a":1}' });
  });

  it("doesn't offer the JSON tool for a text body with nothing selected", async () => {
    show(ok({ kind: "text", contentType: "text/plain", body: "hello" }));
    fireEvent.contextMenu(editorView("Response body").contentDOM);
    await screen.findByRole("menuitem", { name: "Select all" });
    expect(screen.queryByRole("menuitem", { name: "Open in JSON tool" })).not.toBeInTheDocument();
  });

  it("decodes a selected Base64 string in the Base64 tool", async () => {
    const user = userEvent.setup();
    show(ok({ kind: "text", contentType: "text/plain", body: "token: aGVsbG8gd29ybGQ= end" }));
    const view = editorView("Response body");
    const select = (from: number, to: number) =>
      act(() => view.dispatch({ selection: { anchor: from, head: to } }));

    // Not Base64: no entry.
    select(0, 6);
    fireEvent.contextMenu(view.contentDOM);
    await screen.findByRole("menuitem", { name: "Select all" });
    expect(screen.queryByRole("menuitem", { name: "Decode Base64" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    select(7, 23);
    fireEvent.contextMenu(view.contentDOM);
    await user.click(await screen.findByRole("menuitem", { name: "Decode Base64" }));
    const tools = () => useTabsStore.getState().tabs.filter((t) => t.tool?.id === "base64");
    expect(tools()).toHaveLength(1);
    expect(tools()[0].tool?.state).toMatchObject({ input: "aGVsbG8gd29ybGQ=", direction: "decode" });
    expect(useTabsStore.getState().activeId).toBe(tools()[0].id);

    // Again: the open tab's input is replaced, still decoding.
    act(() => {
      useTabsStore
        .getState()
        .updateToolState(tools()[0].id, (st) => ({ ...(st as object), direction: "encode" }));
      useTabsStore.getState().activate("t1");
    });
    // The body's editor mounted again with the request tab.
    const again = editorView("Response body");
    act(() => again.dispatch({ selection: { anchor: 7, head: 15 } }));
    fireEvent.contextMenu(again.contentDOM);
    await user.click(await screen.findByRole("menuitem", { name: "Decode Base64" }));
    expect(tools()).toHaveLength(1);
    expect(tools()[0].tool?.state).toMatchObject({ input: "aGVsbG8g", direction: "decode" });
  });

  it("shows what went over the wire in the Debug tab", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const hops = [makeHop({ statusCode: 302, statusText: "Found" }), makeHop({ reusedConn: true })];
    show(makeResult({ response: makeResponse(), historyId: 5, hops }));

    await user.click(screen.getByRole("tab", { name: "Debug" }));
    expect(screen.getByText(/2 requests, 1 redirect/)).toHaveTextContent(
      "Secrets were sent with their values and show here as [secret:name]; {{name}} is a variable that had no value",
    );
    expect(editorText("Debug details")).toBe(debugText(hops));

    await user.click(screen.getByRole("button", { name: "Search in debug details" }));
    expect(editorView("Debug details").dom.querySelector(".cm-search")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy debug details" }));
    expect(writeText).toHaveBeenCalledWith(debugText(hops));
    expect(toast.success).toHaveBeenCalledWith("Debug details copied");
    writeText.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy debug details" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the debug details", expect.anything());
  });

  it("explains that history doesn't keep debug details", async () => {
    const user = userEvent.setup();
    show(ok());
    await user.click(screen.getByRole("tab", { name: "Debug" }));
    expect(screen.getByText(/History doesn't keep debug details/)).toBeInTheDocument();
  });

  it("shows what was sent from a failed send, and goes back", async () => {
    const user = userEvent.setup();
    const hops = [makeHop({ proto: "", statusCode: 0, error: "Connection refused" })];
    show(makeResult({ error: { kind: "connection_refused", message: "refused" }, hops }));
    await user.click(screen.getByRole("button", { name: "Show what was sent" }));
    expect(editorText("Debug details")).toContain("[Failed: Connection refused]");
    await user.click(screen.getByRole("button", { name: "Back to the error" }));
    expect(screen.queryByLabelText("Debug details")).not.toBeInTheDocument();

    // Nothing sent (a variable loop): no link, and the Debug view says so.
    show(makeResult({ error: { kind: "variables", message: "loop" } }));
    expect(screen.queryByRole("button", { name: "Show what was sent" })).not.toBeInTheDocument();
  });

  it("notes invalid JSON and disables save when not recorded", () => {
    show(ok({ body: "{oops" }, 0));
    expect(screen.getByText(/isn't valid JSON/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save response to file" })).toBeDisabled();
  });

  it("previews HTML in a sandboxed frame", async () => {
    const user = userEvent.setup();
    show(ok({ kind: "html", contentType: "text/html", body: "<h1>Hi</h1><script>x()</script>" }));
    await user.click(screen.getByRole("radio", { name: "Preview" }));
    const frame = screen.getByTitle("HTML preview");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("srcdoc", "<h1>Hi</h1><script>x()</script>");
    expect(screen.getByRole("button", { name: "Search in response" })).toBeDisabled();
  });

  it("previews images from base64 and SVG text", () => {
    const { unmount } = show(
      ok({ kind: "image", contentType: "image/png", encoding: "base64", body: "AAAA" }),
    );
    expect(screen.getByRole("img", { name: "Response image" })).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA",
    );
    unmount();
    show(ok({ kind: "image", contentType: "", encoding: "utf8", body: "<svg/>" }));
    expect(screen.getByRole("img", { name: "Response image" }).getAttribute("src")).toMatch(
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
  });

  it("describes binary and empty bodies", () => {
    const { unmount } = show(ok({ kind: "binary", size: 3000, encoding: "base64", body: "AAAA" }));
    expect(screen.getByText(/This is binary data \(2\.9 KB\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDisabled();
    unmount();
    show(ok({ kind: "empty", size: 0, body: "" }));
    expect(screen.getByText("The response has no body.")).toBeInTheDocument();
  });

  it("offers to save truncated bodies", async () => {
    const user = userEvent.setup();
    const { unmount } = show(ok({ truncated: true, size: 50 * 1024 * 1024, kind: "text", body: "abc" }));
    expect(screen.getByText(/first part of a 50 MB response/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save it to a file" }));
    expect(api.saveResponseBody).toHaveBeenCalledWith(5);
    unmount();
    show(ok({ truncated: true, size: 50 * 1024 * 1024, kind: "text", body: "abc" }, 0));
    expect(screen.queryByRole("button", { name: "Save it to a file" })).not.toBeInTheDocument();
  });

  it("remembers the open section when the pane comes back", async () => {
    const user = userEvent.setup();
    const first = show(ok());
    await user.click(screen.getByRole("tab", { name: /^Headers/ }));
    first.unmount();
    render(
      <TooltipProvider>
        <ResponsePane />
      </TooltipProvider>,
    );
    expect(screen.getByRole("tab", { name: /^Headers/ })).toHaveAttribute("aria-selected", "true");
  });

  it("lists headers and cookies", async () => {
    const user = userEvent.setup();
    show(
      ok({
        cookies: [
          {
            name: "sid",
            value: "xyz",
            domain: "api.dev",
            path: "/",
            expires: "2030-01-01T00:00:00Z",
            maxAge: 0,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          {
            name: "pref",
            value: "1",
            domain: "",
            path: "",
            expires: "",
            maxAge: 0,
            httpOnly: false,
            secure: false,
            sameSite: "",
          },
        ],
      }),
    );
    await user.click(screen.getByRole("tab", { name: /Headers/ }));
    const headers = screen.getByRole("table", { name: "Response headers" });
    expect(within(headers).getByText("X-Request-Id")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Cookies/ }));
    const cookies = screen.getByRole("table", { name: "Response cookies" });
    expect(within(cookies).getByText("HttpOnly, Secure, SameSite=Lax")).toBeInTheDocument();
    expect(within(cookies).getByText("Session")).toBeInTheDocument();
  });

  it("explains missing headers and cookies", async () => {
    const user = userEvent.setup();
    show(ok({ headers: [], cookies: [] }));
    await user.click(screen.getByRole("tab", { name: /Headers/ }));
    expect(screen.getByText("The response has no headers.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Cookies/ }));
    await waitFor(() => expect(screen.getByText("The response set no cookies.")).toBeInTheDocument());
  });

  it("notes unresolved variables without blocking the response", () => {
    show({ ...ok(), unresolved: ["baseUrl", "token"] });
    const note = screen.getByRole("note", { name: "Variables" });
    expect(note).toHaveTextContent(
      "Unresolved variables: {{baseUrl}}, {{token}}. They were sent as written.",
    );
    expect(screen.getByRole("tab", { name: /Body/ })).toBeInTheDocument();
  });

  it("says when secrets are locked", () => {
    show(makeResult({ error: { kind: "dns", message: "x" }, unresolved: ["token"], secretsLocked: true }));
    const note = screen.getByRole("note", { name: "Variables" });
    expect(note).toHaveTextContent("Secrets are locked, so secret variables were sent as written.");
    expect(note).toHaveTextContent("Unresolved variables: {{token}}");
    expect(note).not.toHaveTextContent("They were sent as written.");
  });

  it("shows no note when every variable resolved, or while sending", () => {
    const { unmount } = show(ok());
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    unmount();
    show({ ...ok(), unresolved: ["a"] }, "s1");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("explains a variable loop", () => {
    show(
      makeResult({
        error: { kind: "variables", message: "Variables refer to each other in a loop (a -> b -> a)." },
      }),
    );
    expect(screen.getByRole("heading", { name: "Variables couldn't be resolved" })).toBeInTheDocument();
    expect(screen.getByText(/a -> b -> a/)).toBeInTheDocument();
  });
});
