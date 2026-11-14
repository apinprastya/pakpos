import { toast } from "sonner";
import { api } from "@/lib/api";
import { emptyRequest, type SendResult } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { activeTab, resetTabs } from "@/test/store";
import {
  cancelTab,
  pickFile,
  prepareForCollection,
  saveResponseBody,
  saveTab,
  saveTabAs,
  sendTab,
} from "./actions";
import { makeResult } from "@/test/fixtures";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

describe("request actions", () => {
  beforeEach(() => {
    resetTabs({ url: "https://x.dev", headers: [{ key: "", value: "", enabled: true }] });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("sends a compacted request and stores the result", async () => {
    vi.mocked(api.send).mockResolvedValue(makeResult({ response: null, error: null, historyId: 7 }));
    await sendTab("t1");
    const [sendId, req] = vi.mocked(api.send).mock.calls[0];
    expect(typeof sendId).toBe("string");
    expect(req.headers).toEqual([]);
    expect(activeTab().result?.historyId).toBe(7);
    expect(activeTab().sendId).toBeNull();
  });

  it("does not send without a URL, while sending, or for unknown tabs", async () => {
    await sendTab("missing");
    useTabsStore.getState().setSending("t1", "busy");
    await sendTab("t1");
    resetTabs({ url: "  " });
    await sendTab("t1");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("turns a rejected send into a network error", async () => {
    vi.mocked(api.send).mockRejectedValue(new Error("bridge down"));
    await sendTab("t1");
    expect(activeTab().result?.error).toEqual({ kind: "network", message: "bridge down" });
    vi.mocked(api.send).mockRejectedValue("plain");
    await sendTab("t1");
    expect(activeTab().result?.error?.message).toBe("plain");
  });

  it("drops results for tabs that were closed meanwhile", async () => {
    let resolve!: (v: SendResult) => void;
    vi.mocked(api.send).mockReturnValue(new Promise((r) => (resolve = r)));
    const p = sendTab("t1");
    useTabsStore.getState().close("t1");
    resolve(makeResult({ response: null, error: null, historyId: 1 }));
    await p;
    expect(useTabsStore.getState().tabs[0].result).toBeNull();
  });

  it("cancels the running send", async () => {
    await cancelTab("t1");
    expect(api.cancel).not.toHaveBeenCalled();
    useTabsStore.getState().setSending("t1", "s1");
    await cancelTab("t1");
    expect(api.cancel).toHaveBeenCalledWith("s1");
    vi.mocked(api.cancel).mockRejectedValue(new Error("no"));
    await cancelTab("t1");
    expect(toast.error).toHaveBeenCalled();
  });

  it("opens the save dialog for new requests", async () => {
    expect(await saveTab("missing")).toBe(false);
    expect(await saveTab("t1", true)).toBe(false);
    expect(useTabsStore.getState().saveDialog).toEqual({ tabId: "t1", closeAfter: true });
  });

  it("saves existing requests in place and can close after", async () => {
    const saved = { ...emptyRequest(), id: "r1", name: "R" };
    resetTabs({ ...saved, url: "changed" }, { saved });
    expect(await saveTab("t1")).toBe(true);
    expect(api.save).toHaveBeenCalled();
    expect(activeTab().saved?.url).toBe("changed");
    expect(toast.success).toHaveBeenCalledWith("Request saved");

    expect(await saveTab("t1", true)).toBe(true);
    expect(useTabsStore.getState().tabs[0].id).not.toBe("t1");
  });

  it("reports save failures", async () => {
    const saved = { ...emptyRequest(), id: "r1" };
    resetTabs(saved, { saved });
    vi.mocked(api.save).mockRejectedValue(new Error("disk full"));
    expect(await saveTab("t1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the request", { description: "disk full" });
  });

  it("saves as a new request in a collection", async () => {
    expect(await saveTabAs("missing", "c", "n")).toBe(false);
    expect(await saveTabAs("t1", "c1", "Login")).toBe(true);
    expect(api.saveAs).toHaveBeenCalledWith("c1", "Login", expect.objectContaining({ name: "Login" }));
    expect(activeTab().request.id).toBe("saved-id");
    expect(activeTab().parentId).toBe("c1");
    vi.mocked(api.saveAs).mockRejectedValue(new Error("x"));
    expect(await saveTabAs("t1", "c1", "Login")).toBe(false);
  });

  it("sends the tab's parent so drafts inherit", async () => {
    resetTabs({ url: "{{baseUrl}}/x" }, { parentId: "f1" });
    vi.mocked(api.send).mockResolvedValue(makeResult({ historyId: 2, unresolved: ["baseUrl"] }));
    await sendTab("t1");
    expect(vi.mocked(api.send).mock.calls[0][2]).toBe("f1");
    expect(activeTab().result?.unresolved).toEqual(["baseUrl"]);
  });

  it("switches untouched auth to inherit when saving into a collection", async () => {
    expect(await saveTabAs("t1", "c1", "Login")).toBe(true);
    expect(vi.mocked(api.saveAs).mock.calls[0][2].auth.type).toBe("inherit");
    expect(activeTab().request.auth.type).toBe("inherit");
  });

  it.each([
    ["bearer", { type: "bearer" as const, token: "abc" }],
    ["none with a leftover token", { type: "none" as const, token: "abc" }],
    ["none with the key in the query", { type: "none" as const, apiIn: "query" as const }],
    ["inherit", { type: "inherit" as const }],
  ])("keeps auth the user set (%s)", async (_name, auth) => {
    resetTabs({ url: "https://x.dev", auth: { ...emptyRequest().auth, ...auth } });
    expect(await saveTabAs("t1", "c1", "Login")).toBe(true);
    expect(vi.mocked(api.saveAs).mock.calls[0][2].auth).toEqual({ ...emptyRequest().auth, ...auth });
  });

  it("prepares only untouched auth for a collection", () => {
    const req = emptyRequest();
    expect(prepareForCollection(req).auth.type).toBe("inherit");
    expect(req.auth.type).toBe("none");
    const set = { ...req, auth: { ...req.auth, type: "basic" as const, username: "u" } };
    expect(prepareForCollection(set)).toBe(set);
  });

  it("picks files and saves response bodies", async () => {
    vi.mocked(api.pickFile).mockResolvedValue("/tmp/a.png");
    expect(await pickFile()).toBe("/tmp/a.png");
    vi.mocked(api.pickFile).mockRejectedValue(new Error("x"));
    expect(await pickFile()).toBe("");

    vi.mocked(api.saveResponseBody).mockResolvedValue("/tmp/out.json");
    await saveResponseBody(3);
    expect(toast.success).toHaveBeenCalledWith("Response saved", { description: "/tmp/out.json" });
    vi.mocked(toast.success).mockClear();
    vi.mocked(api.saveResponseBody).mockResolvedValue("");
    await saveResponseBody(3);
    expect(toast.success).not.toHaveBeenCalled();
    vi.mocked(api.saveResponseBody).mockRejectedValue(new Error("x"));
    await saveResponseBody(3);
    expect(toast.error).toHaveBeenCalled();
  });
});
