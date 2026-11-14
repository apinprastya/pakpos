import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { UpdateInfo, UpdateProgress } from "@/lib/model";

/**
 * Where the update flow is: idle (nothing checked, or the check failed),
 * checking, checked (`info` set), installing (`progress` set), installed
 * (restart to use it).
 */
export type UpdatePhase = "idle" | "checking" | "checked" | "installing" | "installed";

/** localStorage key of the release the user chose to skip (a UI preference). */
export const SKIPPED_KEY = "pakpos-update-skipped";

/** Automatic checks: the first shortly after start, then once a day. */
export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  dialogOpen: boolean;
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  /** The version the user skipped: automatic checks don't announce it. */
  skipped: string;

  openDialog: () => void;
  closeDialog: () => void;
  /** Opens the dialog and checks GitHub for the latest release. */
  check: () => Promise<void>;
  /**
   * Checks quietly (the "check for updates" setting). Failures are ignored; a
   * new release that isn't skipped is announced once with a toast.
   */
  autoCheck: () => Promise<void>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
  restart: () => Promise<void>;
  openReleasePage: () => Promise<void>;
  /** Stops announcing the checked release and closes the dialog. */
  skip: () => void;
}

function readSkipped(): string {
  try {
    return localStorage.getItem(SKIPPED_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSkipped(version: string): void {
  try {
    localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    // Only a convenience: the release is announced again next time.
  }
}

/** The running install was cancelled by the user (its error is not shown). */
let cancelled = false;
/** Versions already announced by a toast in this session. */
const announced = new Set<string>();

/** Test hook: forgets the session's announcements. */
export function resetUpdateAnnouncements(): void {
  announced.clear();
}

const busy = (phase: UpdatePhase) => phase === "installing" || phase === "installed";

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  dialogOpen: false,
  phase: "idle",
  info: null,
  progress: null,
  error: null,
  skipped: readSkipped(),

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false, error: busy(get().phase) ? get().error : null }),

  check: async () => {
    if (busy(get().phase)) {
      set({ dialogOpen: true });
      return;
    }
    set({ dialogOpen: true, phase: "checking", error: null });
    try {
      const info = await api.checkForUpdates();
      set({ phase: "checked", info });
    } catch (e) {
      set({ phase: "idle", info: null, error: errorMessage(e) });
    }
  },

  autoCheck: async () => {
    const { phase } = get();
    if (phase !== "idle" && phase !== "checked") return;
    let info: UpdateInfo;
    try {
      info = await api.checkForUpdates();
    } catch {
      return; // offline, rate-limited…: try again next time
    }
    // A manual check or install may have started meanwhile; keep its state.
    const now = get().phase;
    if (now !== "idle" && now !== "checked") return;
    set({ phase: "checked", info, error: now === "idle" ? null : get().error });
    if (!info.available || info.latest === get().skipped || announced.has(info.latest)) return;
    announced.add(info.latest);
    toast.info(`Pakpos ${info.latest} is available`, {
      description: `You have ${info.current}.`,
      action: { label: "View update", onClick: () => get().openDialog() },
      duration: 15_000,
    });
  },

  install: async () => {
    if (get().phase !== "checked" || !get().info?.canInstall) return;
    cancelled = false;
    set({ phase: "installing", error: null, progress: null });
    const off = api.onUpdateProgress((progress) => set({ progress }));
    try {
      await api.installUpdate();
      set({ phase: "installed" });
    } catch (e) {
      set({ phase: "checked", error: cancelled ? null : errorMessage(e), progress: null });
    } finally {
      off();
    }
  },

  cancel: async () => {
    if (get().phase !== "installing") return;
    cancelled = true;
    await api.cancelUpdate();
  },

  restart: async () => {
    try {
      await api.restartToUpdate();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  openReleasePage: async () => {
    try {
      await api.openReleasePage();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  skip: () => {
    const version = get().info?.latest;
    if (!version) return;
    writeSkipped(version);
    set({ skipped: version, dialogOpen: false, error: null });
  },
}));

/** True when a newer release is known and the user hasn't skipped it (or it's installed). */
export function selectUpdateBadge(s: UpdateState): "available" | "installed" | null {
  if (s.phase === "installed") return "installed";
  if (s.phase === "installing") return null;
  if (s.info?.available && s.info.latest !== s.skipped) return "available";
  return null;
}
