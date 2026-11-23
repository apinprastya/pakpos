import { toast } from "sonner";
import { api } from "@/lib/api";
import { normalizeImportResult, normalizeImportSummary } from "@/lib/importModel";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { importPostmanFile } from "./actions";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn() } };
});

const preview = normalizeImportSummary({ kind: "collection", name: "Shop", requests: 2 });

describe("importPostmanFile", () => {
  beforeEach(() => vi.mocked(toast.success).mockClear());

  it("imports a collection, refreshes the tree and reveals it", async () => {
    vi.mocked(api.importPostman).mockResolvedValue(normalizeImportResult({ ...preview, id: "c1" }));
    const refresh = vi.spyOn(useWorkspaceStore.getState(), "refresh").mockResolvedValue();
    const reveal = vi.spyOn(useTreeStore.getState(), "revealInTree").mockReturnValue(true);

    const res = await importPostmanFile("/x.json", { guessSecrets: true }, preview);

    expect(res?.id).toBe("c1");
    expect(api.importPostman).toHaveBeenCalledWith("/x.json", { guessSecrets: true });
    expect(refresh).toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith("c1", { show: true });
    expect(toast.success).toHaveBeenCalledWith('Imported "Shop"', { description: "2 requests" });
  });

  it("opens an imported environment", async () => {
    vi.mocked(api.importPostman).mockResolvedValue(
      normalizeImportResult({ kind: "environment", name: "Dev", id: "e1", variables: 2 }),
    );
    const envs = useEnvironmentsStore.getState();
    const load = vi.spyOn(envs, "load").mockResolvedValue();
    const touch = vi.spyOn(envs, "touch").mockImplementation(() => {});
    const open = vi.spyOn(envs, "open").mockImplementation(() => {});

    await importPostmanFile(
      "/e.json",
      { guessSecrets: false },
      normalizeImportSummary({ kind: "environment" }),
    );

    expect(load).toHaveBeenCalled();
    expect(touch).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("e1");
  });

  it("opens the globals after merging them", async () => {
    vi.mocked(api.importPostman).mockResolvedValue(
      normalizeImportResult({ kind: "globals", name: "Globals" }),
    );
    const envs = useEnvironmentsStore.getState();
    vi.spyOn(envs, "load").mockResolvedValue();
    const openGlobals = vi.spyOn(envs, "openGlobals").mockImplementation(() => {});

    await importPostmanFile("/g.json", { guessSecrets: false }, normalizeImportSummary({ kind: "globals" }));

    expect(openGlobals).toHaveBeenCalled();
  });

  it("asks for the secret store first and stops when it isn't unlocked", async () => {
    const ensure = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValue(false);
    const withSecrets = { ...preview, secretValues: true };

    expect(await importPostmanFile("/x.json", { guessSecrets: true }, withSecrets)).toBeNull();
    expect(ensure).toHaveBeenCalled();
    expect(api.importPostman).not.toHaveBeenCalled();

    ensure.mockResolvedValue(true);
    vi.mocked(api.importPostman).mockResolvedValue(normalizeImportResult({ ...preview, id: "c2" }));
    vi.spyOn(useWorkspaceStore.getState(), "refresh").mockResolvedValue();
    expect((await importPostmanFile("/x.json", { guessSecrets: true }, withSecrets))?.id).toBe("c2");
  });

  it("rejects with Go's message", async () => {
    vi.mocked(api.importPostman).mockRejectedValue(new Error("The secret store is locked."));
    await expect(importPostmanFile("/x.json", { guessSecrets: true }, preview)).rejects.toThrow("locked");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
