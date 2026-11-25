import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LazyDialogs } from "@/features/shell/LazyDialogs";
import { Sidebar } from "@/features/shell/Sidebar";
import { api } from "@/lib/api";
import { emptyRequest, type HistoryEntry } from "@/lib/model";
import { makeHistorySummary, makeResponse } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { useHistoryCompareStore } from "@/stores/historyCompare";
import { useLayoutStore } from "@/stores/layout";
import { requestText, responseText } from "./entryText";

function entry(id: number, body: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ...makeHistorySummary(id, { method: "POST", createdAt: `2026-11-14T10:0${id}:00Z` }),
    request: {
      ...emptyRequest(),
      method: "POST",
      url: "https://api.test/items?{{q}}",
      headers: [
        { key: "Accept", value: "application/json", enabled: true },
        { key: "X-Off", value: "1", enabled: false },
      ],
      body: { ...emptyRequest().body, type: "raw", language: "json", raw: `{"n":${id}}` },
      auth: { ...emptyRequest().auth, type: "bearer", token: "{{token}}" },
    },
    response: makeResponse({
      body,
      statusCode: 200,
      statusText: "200 OK",
      headers: [{ key: "X-Id", value: String(id), enabled: true }],
    }),
    ...patch,
  };
}

function renderAll() {
  useLayoutStore.setState({ sidebarView: "history" });
  return render(
    <TooltipProvider>
      <Sidebar />
      <LazyDialogs />
    </TooltipProvider>,
  );
}

describe("comparing history entries", () => {
  beforeEach(() => resetTabs());

  it("picks two entries from the history list and shows their differences", async () => {
    const user = userEvent.setup();
    const a = entry(1, '{"id":1,"name":"Ada","tags":["x"]}');
    const b = entry(2, '{"name":"Ada","id":1,"tags":["y"]}');
    vi.mocked(api.historyList).mockResolvedValue({ items: [b, a], total: 2 });
    vi.mocked(api.historyGet).mockImplementation(async (id) => (id === 1 ? a : b));
    renderAll();

    const rows = await screen.findAllByRole("button", { name: /^POST https:\/\/x\// });
    expect(rows).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Compare with another entry" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("Pick an entry to compare with POST");
    // The base row stops comparing; the other compares.
    expect(screen.getByRole("button", { name: /^Stop comparing POST https:\/\/x\/2/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Compare with another entry" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Compare with POST https:\/\/x\/1/ }));

    const dialog = await screen.findByRole("dialog", { name: "Compare history entries" });
    expect(api.historyGet).toHaveBeenCalledWith(1);
    expect(api.historyGet).toHaveBeenCalledWith(2);
    // The earlier entry is "−", whichever was picked first.
    expect(within(dialog).getByLabelText("Earlier").nextElementSibling).toHaveTextContent("x/1");
    expect(within(dialog).getByLabelText("Later").nextElementSibling).toHaveTextContent("x/2");
    const list = await within(dialog).findByRole("list", { name: "Differences between the responses" });
    expect(within(list).getByRole("listitem", { name: "removed: X-Id: 1" })).toBeInTheDocument();
    expect(within(list).getByRole("listitem", { name: "added: X-Id: 2" })).toBeInTheDocument();
    expect(within(list).getByRole("listitem", { name: /^removed: +"id": 1,$/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: /Response/ })).toHaveTextContent("+3 −3");

    // Ignoring key order leaves only the real change.
    await user.click(within(dialog).getByRole("switch", { name: "Ignore JSON key order" }));
    expect(within(dialog).getByRole("tab", { name: /Response/ })).toHaveTextContent("+2 −2");
    expect(within(list).getByRole("listitem", { name: /^added: +"y"$/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("tab", { name: /Request/ }));
    const req = within(dialog).getByRole("list", { name: "Differences between the requests" });
    expect(within(req).getByRole("listitem", { name: /^removed: +"n": 1$/ })).toBeInTheDocument();
    // Unchanged lines far from a change fold away.
    expect(within(req).getByRole("button", { name: "Show 2 unchanged lines" })).toBeInTheDocument();
    await user.click(within(req).getByRole("button", { name: "Show 2 unchanged lines" }));
    expect(
      within(req).getByRole("listitem", { name: "unchanged: POST https://api.test/items?{{q}}" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(useHistoryCompareStore.getState().pair).toBeNull());
  });

  it("cancels picking, and picking the same entry again stops", async () => {
    const user = userEvent.setup();
    const a = entry(1, "{}");
    vi.mocked(api.historyList).mockResolvedValue({ items: [a], total: 1 });
    renderAll();
    await user.click(await screen.findByRole("button", { name: "Compare with another entry" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compare with another entry" }));
    await user.click(screen.getByRole("button", { name: /^Stop comparing/ }));
    expect(useHistoryCompareStore.getState()).toMatchObject({ base: null, pair: null });
  });

  it("says when entries are the same, too different, or can't load", async () => {
    const a = entry(1, "{}");
    vi.mocked(api.historyGet).mockResolvedValue(a);
    renderAll();
    useHistoryCompareStore.getState().compare(a, { ...a, id: 2 });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("The responses are the same.")).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: /Response/ })).toHaveTextContent("same");

    useHistoryCompareStore.getState().close();
    const big = (n: number) => Array.from({ length: 5000 }, (_, i) => `"${n}-${i}"`).join(",");
    vi.mocked(api.historyGet).mockImplementation(async (id) => entry(id, `[${big(id)}]`));
    useHistoryCompareStore.getState().compare(a, { ...a, id: 3 });
    expect(
      await screen.findByText("These responses differ in too many lines to compare line by line."),
    ).toBeInTheDocument();

    useHistoryCompareStore.getState().close();
    vi.mocked(api.historyGet).mockRejectedValue(new Error("entry 9 not found"));
    useHistoryCompareStore.getState().compare(a, { ...a, id: 9 });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the entries: entry 9 not found",
    );
  });
});

describe("entry text", () => {
  const base = entry(1, "{}");
  it("writes the request as sent, without disabled rows or secrets' values", () => {
    expect(requestText(base, { sortKeys: false })).toEqual([
      "POST https://api.test/items?{{q}}",
      "Accept: application/json",
      "Auth: bearer",
      "",
      "{",
      '  "n": 1',
      "}",
    ]);
    const form = {
      ...base,
      request: {
        ...base.request,
        auth: { ...base.request.auth, type: "inherit" as const },
        body: {
          ...base.request.body,
          type: "form-data" as const,
          formData: [
            { key: "a", kind: "text" as const, value: "1", filePath: "", contentType: "", enabled: true },
            {
              key: "f",
              kind: "file" as const,
              value: "",
              filePath: "/tmp/x.png",
              contentType: "",
              enabled: true,
            },
            { key: "off", kind: "text" as const, value: "", filePath: "", contentType: "", enabled: false },
          ],
        },
      },
    };
    expect(requestText(form, { sortKeys: false }).slice(2)).toEqual(["", "a: 1", "f: <file /tmp/x.png>"]);
    const encoded = {
      ...form,
      request: {
        ...form.request,
        body: {
          ...form.request.body,
          type: "urlencoded" as const,
          urlEncoded: [{ key: "a", value: "b c", enabled: true }],
        },
      },
    };
    expect(requestText(encoded, { sortKeys: false }).at(-1)).toBe("a=b c");
    const binary = {
      ...form,
      request: {
        ...form.request,
        body: { ...form.request.body, type: "binary" as const, binaryPath: "/f.bin" },
      },
    };
    expect(requestText(binary, { sortKeys: false }).at(-1)).toBe("<file /f.bin>");
    const text = {
      ...form,
      request: { ...form.request, body: { ...form.request.body, type: "raw" as const, raw: "plain" } },
    };
    expect(requestText(text, { sortKeys: true }).at(-1)).toBe("plain");
    const none = {
      ...form,
      request: { ...form.request, body: { ...form.request.body, type: "none" as const } },
    };
    expect(requestText(none, { sortKeys: false })).toHaveLength(2);
  });

  it("writes the response: status, headers, body, and what can't be shown", () => {
    expect(responseText(base, { sortKeys: false })).toEqual(["200 OK", "X-Id: 1", "", "{}"]);
    expect(
      responseText({ ...base, response: null, errorMessage: "no such host" }, { sortKeys: false }),
    ).toEqual(["No response: no such host"]);
    expect(responseText({ ...base, response: null }, { sortKeys: false })).toEqual([
      "No response: the request failed",
    ]);
    const bin = {
      ...base,
      response: makeResponse({
        kind: "binary",
        encoding: "base64",
        body: "AAA=",
        size: 2048,
        headers: [],
        statusText: "OK",
      }),
    };
    expect(responseText(bin, { sortKeys: false })).toEqual(["200 OK", "", "<binary body, 2.0 KB>"]);
    const cut = {
      ...base,
      response: makeResponse({ body: '{"b":1,"a":2', truncated: true, size: 20_000_000, headers: [] }),
    };
    const lines = responseText(cut, { sortKeys: true });
    expect(lines.at(-2)).toBe('{"b":1,"a":2');
    expect(lines.at(-1)).toMatch(/^<cut: only the first part of a .* body is kept>$/);
  });
});
