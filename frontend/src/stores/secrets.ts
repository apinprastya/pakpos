import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { SecretsStatus } from "@/lib/model";

/** The master password dialogs (file store only). */
export type SecretsDialog = "set-password" | "unlock" | "change-password" | "reset" | null;

/**
 * The secret store's state (keychain, or the encrypted file with its master
 * password) and the dialogs that unlock it. No secret value is ever kept here.
 */
interface SecretsState {
  status: SecretsStatus | null;
  dialog: SecretsDialog;

  refresh: () => Promise<SecretsStatus | null>;
  /**
   * Resolves true when secrets can be read and written now. With the file
   * store it first asks for a new master password (none set yet) or the
   * current one (locked); false when the user cancels.
   */
  ensureReady: () => Promise<boolean>;
  openDialog: (dialog: Exclude<SecretsDialog, null>) => void;
  /** Closes the dialog; `ok` tells a waiting `ensureReady` whether it can go on. */
  closeDialog: (ok?: boolean) => void;

  /** These reject with Go's message (e.g. "Wrong password, or the secrets file is damaged."). */
  setPassword: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  lock: () => Promise<void>;
  reset: () => Promise<void>;
}

/** Waiting `ensureReady` calls, resolved when the dialog closes. */
let waiters: ((ok: boolean) => void)[] = [];

function settle(ok: boolean) {
  const pending = waiters;
  waiters = [];
  for (const w of pending) w(ok);
}

export const useSecretsStore = create<SecretsState>()((set, get) => ({
  status: null,
  dialog: null,

  refresh: async () => {
    try {
      const status = await api.secretsStatus();
      set({ status });
      return status;
    } catch {
      return get().status;
    }
  },

  ensureReady: async () => {
    const status = await get().refresh();
    if (!status || status.backend === "keychain") return true;
    if (status.hasPassword && !status.locked) return true;
    return new Promise<boolean>((resolve) => {
      waiters.push(resolve);
      set({ dialog: status.hasPassword ? "unlock" : "set-password" });
    });
  },

  openDialog: (dialog) => set({ dialog }),

  closeDialog: (ok = false) => {
    set({ dialog: null });
    settle(ok);
  },

  setPassword: async (password) => {
    await api.setMasterPassword(password);
    await get().refresh();
  },

  unlock: async (password) => {
    await api.unlockSecrets(password);
    await get().refresh();
  },

  changePassword: async (current, next) => {
    await api.changeMasterPassword(current, next);
    await get().refresh();
  },

  lock: async () => {
    try {
      await api.lockSecrets();
      toast.success("Secrets locked");
    } catch (e) {
      toast.error("Couldn't lock the secrets", { description: errorMessage(e) });
    }
    await get().refresh();
  },

  reset: async () => {
    await api.resetSecretStore();
    await get().refresh();
  },
}));

/** True when the encrypted file store is in use and secrets can't be read right now. */
export function needsUnlock(status: SecretsStatus | null): boolean {
  return !!status && status.backend === "file" && (status.locked || !status.hasPassword);
}
