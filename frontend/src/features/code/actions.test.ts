import { toast } from "sonner";
import { api } from "@/lib/api";
import { emptyRequest, normalizeRequest } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { makeCodeResult } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { copyAsCurl, copySavedAsCurl, importCurlIntoTab, PASTE_TOAST_ID, pastedName } from "./actions";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn() } };
});

const imported = normalizeRequest({
  name: "POST /orders",
  method: "POST",
  url: "https://api.example.com/orders",
  headers: [{ key: "X-A", value: "1", enabled: true }],
  body: { type: "raw", language: "json", raw: "{}" },
});

type ToastOpts = { action: { onClick: () => void }; description?: unknown };
const lastSuccess = () => vi.mocked(toast.success).mock.calls.at(-1) as unknown as [string, ToastOpts];

describe("importCurlIntoTab", () => {
  beforeEach(() => vi.mocked(toast.success).mockClear());

  it("replaces the request, keeps the tab's identity and parent, and undoes", async () => {
    const saved = { ...emptyRequest(), id: "r1", name: "Orders", seq: 3, url: "https://old" };
    resetTabs(saved, { saved, parentId: "f1" });
    vi.mocked(api.importCurl).mockResolvedValue({ request: imported, warnings: [] });

    await importCurlIntoTab("t1", "curl https://api.example.com/orders");

    expect(api.importCurl).toHaveBeenCalledWith("curl https://api.example.com/orders");
    const tab = activeTab();
    expect(tab.request).toMatchObject({
      id: "r1",
      name: "Orders",
      seq: 3,
      method: "POST",
      url: imported.url,
    });
    expect(tab.request.headers).toEqual(imported.headers);
    expect(tab.parentId).toBe("f1");
    const [title, opts] = lastSuccess();
    expect(title).toBe("Imported from cURL");
    expect(opts.description).toBeUndefined();

    opts.action.onClick();
    expect(activeTab().request).toEqual(saved);
  });

  it("lists warnings in a toast that stays 8 seconds and closes when a dialog opens", async () => {
    resetTabs();
    vi.mocked(api.importCurl).mockResolvedValue({
      request: imported,
      warnings: [{ option: "-k", message: "TLS note" }],
    });
    await importCurlIntoTab("t1", "curl -k x");
    expect(lastSuccess()[1]).toMatchObject({ id: PASTE_TOAST_ID, duration: 8_000 });
    expect(lastSuccess()[1].description).toBeTruthy();
  });

  it("names an unnamed draft after the import, and keeps other names", async () => {
    vi.mocked(api.importCurl).mockResolvedValue({ request: imported, warnings: [] });
    resetTabs();
    await importCurlIntoTab("t1", "curl x");
    expect(activeTab().request.name).toBe("POST /orders");
    expect(lastSuccess()[1]).toMatchObject({ duration: 6_000 });
    resetTabs({ name: "My draft" });
    await importCurlIntoTab("t1", "curl x");
    expect(activeTab().request.name).toBe("My draft");
  });

  it.each([
    ["saved keeps its name", "Orders", true, "Orders"],
    ["saved keeps even Untitled request", "Untitled request", true, "Untitled request"],
    ["unnamed draft", "", false, "GET /x"],
    ["draft named Untitled request", "Untitled request", false, "GET /x"],
    ["named draft", "Mine", false, "Mine"],
  ])("pastedName: %s", (_, name, saved, want) => {
    expect(pastedName({ ...emptyRequest(), name }, saved, "GET /x")).toBe(want);
  });

  it("undo does nothing once the tab is closed, and a doc tab is left alone", async () => {
    resetTabs();
    vi.mocked(api.importCurl).mockResolvedValue({ request: imported, warnings: [] });
    await importCurlIntoTab("t1", "curl x");
    useTabsStore.setState({ tabs: [], activeId: "" });
    lastSuccess()[1].action.onClick();
    expect(useTabsStore.getState().tabs).toEqual([]);

    vi.mocked(toast.success).mockClear();
    resetTabs(
      {},
      { doc: { kind: "globals", targetId: "", name: "", draft: null, saved: null, missing: false } },
    );
    await importCurlIntoTab("t1", "curl x");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports an import error and leaves the request", async () => {
    resetTabs({ url: "https://keep" });
    vi.mocked(api.importCurl).mockRejectedValue(new Error("This isn't a curl command."));
    await importCurlIntoTab("t1", "curl");
    expect(toast.error).toHaveBeenCalledWith("Couldn't import the cURL command", {
      description: "This isn't a curl command.",
    });
    expect(activeTab().request.url).toBe("https://keep");
  });
});

describe("copy as cURL", () => {
  const writeText = vi.fn();
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("copies with variables resolved and secrets masked, noting both", async () => {
    vi.mocked(api.generateCode).mockResolvedValue(
      makeCodeResult({ code: "curl x", masked: ["token"], unresolved: ["host"] }),
    );
    const req = {
      ...emptyRequest(),
      url: "https://{{host}}",
      headers: [{ key: "", value: "", enabled: true }],
    };
    await copyAsCurl(req, "c1");
    expect(api.generateCode).toHaveBeenCalledWith(expect.objectContaining({ headers: [] }), "c1", "curl", {
      resolveVariables: true,
      revealSecrets: false,
    });
    expect(writeText).toHaveBeenCalledWith("curl x");
    expect(toast.success).toHaveBeenCalledWith("Copied as cURL", {
      description: "Secrets are shown as {{token}}. No value for {{host}}, so it's left as written.",
    });
  });

  it("copies quietly when there is nothing to note", async () => {
    vi.mocked(api.generateCode).mockResolvedValue(makeCodeResult({ code: "curl y" }));
    await copyAsCurl(emptyRequest(), "");
    expect(toast.success).toHaveBeenCalledWith("Copied as cURL", { description: undefined });
  });

  it("reports generation and clipboard failures", async () => {
    vi.mocked(api.generateCode).mockRejectedValueOnce(new Error("loop"));
    await copyAsCurl(emptyRequest(), "");
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy as cURL", { description: "loop" });

    vi.mocked(api.generateCode).mockResolvedValue(makeCodeResult({ code: "x" }));
    writeText.mockRejectedValue(new Error("denied"));
    await copyAsCurl(emptyRequest(), "");
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy as cURL", {
      description: "The clipboard isn't available.",
    });
  });

  it("copies a saved request from the tree", async () => {
    vi.mocked(api.getRequest).mockResolvedValue({ ...emptyRequest(), id: "r1", url: "https://saved" });
    vi.mocked(api.generateCode).mockResolvedValue(makeCodeResult({ code: "curl https://saved" }));
    await copySavedAsCurl("r1", "f1");
    expect(api.generateCode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1" }),
      "f1",
      "curl",
      expect.anything(),
    );
    expect(writeText).toHaveBeenCalledWith("curl https://saved");

    vi.mocked(api.getRequest).mockRejectedValue("gone");
    await copySavedAsCurl("r2", "f1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy as cURL", { description: "gone" });
  });
});
