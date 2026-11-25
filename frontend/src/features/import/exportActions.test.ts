import { toast } from "sonner";
import { api } from "@/lib/api";
import { normalizeExportResult } from "@/lib/importModel";
import { describeExportWarnings, exportToPostman } from "./exportActions";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } };
});

const warn = (where: string, message: string) => ({ where, message });

describe("exportToPostman", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("exports a collection and says where it went", async () => {
    vi.mocked(api.exportCollection).mockResolvedValue({ path: "/tmp/shop.json", name: "Shop", warnings: [] });

    const res = await exportToPostman({ kind: "collection", id: "c1" });

    expect(res?.path).toBe("/tmp/shop.json");
    expect(api.exportCollection).toHaveBeenCalledWith("c1");
    expect(toast.success).toHaveBeenCalledWith('Exported "Shop"', { description: "/tmp/shop.json" });
  });

  it("shows what to check in Postman", async () => {
    vi.mocked(api.exportEnvironment).mockResolvedValue({
      path: "/tmp/dev.json",
      name: "Dev",
      warnings: [warn("", "Secret values aren't exported: token.")],
    });

    await exportToPostman({ kind: "environment", id: "e1" });

    expect(api.exportEnvironment).toHaveBeenCalledWith("e1");
    expect(toast.warning).toHaveBeenCalledWith(
      'Exported "Dev". Check these in Postman',
      expect.objectContaining({ description: "Secret values aren't exported: token." }),
    );
  });

  it("names the globals", async () => {
    vi.mocked(api.exportGlobals).mockResolvedValue({ path: "/tmp/g.json", name: "Globals", warnings: [] });
    await exportToPostman({ kind: "globals" });
    expect(toast.success).toHaveBeenCalledWith("Exported the globals", { description: "/tmp/g.json" });
  });

  it("does nothing when the save dialog is cancelled", async () => {
    vi.mocked(api.exportGlobals).mockResolvedValue({ path: "", name: "", warnings: [] });
    expect(await exportToPostman({ kind: "globals" })).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("explains a failure", async () => {
    vi.mocked(api.exportCollection).mockRejectedValue(new Error("This collection no longer exists."));
    expect(await exportToPostman({ kind: "collection", id: "gone" })).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Couldn't export the collection", {
      description: "This collection no longer exists.",
    });
  });
});

describe("describeExportWarnings", () => {
  it("lists the first few with where they apply", () => {
    const ws = [warn("Orders / Create", "a"), warn("", "b"), warn("X", "c"), warn("", "d"), warn("", "e")];
    expect(describeExportWarnings(ws)).toBe("Orders / Create: a\nb\nX: c\nAnd 2 more.");
    expect(describeExportWarnings(ws.slice(0, 2))).toBe("Orders / Create: a\nb");
    expect(describeExportWarnings([])).toBe("");
  });
});

describe("normalizeExportResult", () => {
  it("fills in what Go left null", () => {
    expect(normalizeExportResult(null)).toEqual({ path: "", name: "", warnings: [] });
    expect(
      normalizeExportResult({ path: "/p", name: "n", warnings: [{ where: null, message: "m" }] }),
    ).toEqual({
      path: "/p",
      name: "n",
      warnings: [{ where: "", message: "m" }],
    });
  });
});
