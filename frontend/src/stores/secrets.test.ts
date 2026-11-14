import { toast } from "sonner";
import { api } from "@/lib/api";
import { needsUnlock, useSecretsStore } from "./secrets";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const store = () => useSecretsStore.getState();
const file = (hasPassword: boolean, locked: boolean) => ({ backend: "file" as const, hasPassword, locked });

describe("secrets store", () => {
  it("refreshes the status and keeps the last one when Go fails", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValueOnce(file(true, true));
    expect(await store().refresh()).toEqual(file(true, true));
    vi.mocked(api.secretsStatus).mockRejectedValueOnce(new Error("x"));
    expect(await store().refresh()).toEqual(file(true, true));
  });

  it("is ready at once with the keychain or an unlocked file store", async () => {
    expect(await store().ensureReady()).toBe(true);
    vi.mocked(api.secretsStatus).mockResolvedValue(file(true, false));
    expect(await store().ensureReady()).toBe(true);
    expect(store().dialog).toBeNull();
  });

  it("asks for a new master password when none is set", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue(file(false, true));
    const ready = store().ensureReady();
    await vi.waitFor(() => expect(store().dialog).toBe("set-password"));
    store().closeDialog(true);
    expect(await ready).toBe(true);
    expect(store().dialog).toBeNull();
  });

  it("asks to unlock a locked store, and resolves false on cancel", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue(file(true, true));
    const first = store().ensureReady();
    const second = store().ensureReady();
    await vi.waitFor(() => expect(store().dialog).toBe("unlock"));
    store().closeDialog();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });

  it("sets, unlocks, changes and resets through Go, refreshing after", async () => {
    await store().setPassword("pw");
    await store().unlock("pw");
    await store().changePassword("pw", "next");
    await store().reset();
    expect(api.setMasterPassword).toHaveBeenCalledWith("pw");
    expect(api.unlockSecrets).toHaveBeenCalledWith("pw");
    expect(api.changeMasterPassword).toHaveBeenCalledWith("pw", "next");
    expect(api.resetSecretStore).toHaveBeenCalled();
    expect(api.secretsStatus).toHaveBeenCalledTimes(4);
    vi.mocked(api.unlockSecrets).mockRejectedValueOnce(
      new Error("Wrong password, or the secrets file is damaged."),
    );
    await expect(store().unlock("bad")).rejects.toThrow("Wrong password");
  });

  it("locks and reports failures", async () => {
    await store().lock();
    expect(toast.success).toHaveBeenCalledWith("Secrets locked");
    vi.mocked(api.lockSecrets).mockRejectedValueOnce(new Error("nope"));
    await store().lock();
    expect(toast.error).toHaveBeenCalledWith("Couldn't lock the secrets", { description: "nope" });
  });

  it("opens dialogs directly", () => {
    store().openDialog("change-password");
    expect(store().dialog).toBe("change-password");
  });
});

describe("needsUnlock", () => {
  it("is true only for a file store that is locked or has no password", () => {
    expect(needsUnlock(null)).toBe(false);
    expect(needsUnlock({ backend: "keychain", hasPassword: false, locked: false })).toBe(false);
    expect(needsUnlock(file(true, false))).toBe(false);
    expect(needsUnlock(file(true, true))).toBe(true);
    expect(needsUnlock(file(false, true))).toBe(true);
  });
});
