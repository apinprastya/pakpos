import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Response, SendResult } from "@/lib/model";
import { editorText, editorView } from "@/test/editor";
import { makeResponse } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
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

const ok = (patch: Partial<Response> = {}, historyId = 5): SendResult => ({
  response: makeResponse(patch),
  error: null,
  historyId,
});

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

  it.each(["tls", "timeout", "too_many_redirects"])("offers Open settings for %s errors", async (kind) => {
    const user = userEvent.setup();
    show({ response: null, error: { kind: kind as never, message: "x" }, historyId: 1 });
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useSettingsStore.getState()).toMatchObject({ dialogOpen: true, section: "requests" });
  });

  it("doesn't offer settings for errors settings can't fix", () => {
    show({ response: null, error: { kind: "dns", message: "no such host" }, historyId: 1 });
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
    show({
      response: null,
      error: { kind: "dns", message: "lookup nope.invalid: no such host" },
      historyId: 0,
    });
    expect(screen.getByRole("heading", { name: "Couldn't find the server" })).toBeInTheDocument();
    expect(screen.getByText("lookup nope.invalid: no such host")).toBeInTheDocument();
    expect(screen.getByText(/Check the host name/)).toBeInTheDocument();
  });

  it("shows cancellation quietly", () => {
    show({ response: null, error: { kind: "canceled", message: "context canceled" }, historyId: 0 });
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
});
