import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  isRunning,
  statusKey,
  type CloudflaredStatus,
  type Webhook,
  type WebhookProblem,
  type WebhookRequestSummary,
  type WebhookStatus,
} from "@/lib/webhookModel";
import { isDirty, tabTitle, useTabsStore, type Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSettingsStore } from "@/stores/settings";

export type WebhooksStatus = "idle" | "loading" | "ready" | "error";

/** Rows fetched per page of a webhook's log. */
export const LOG_PAGE = 100;
/** Rows kept per webhook in memory (Go keeps the newest 500). */
export const LOG_CAP = 500;

export interface WebhookLog {
  entries: WebhookRequestSummary[];
  loaded: boolean;
  loading: boolean;
  /** Older rows may exist in Go. */
  hasMore: boolean;
  error: string | null;
}

export interface InstallState {
  running: boolean;
  done: number;
  total: number;
}

/**
 * The open workspace's webhooks, every running webhook (of any workspace:
 * they keep running after a switch), their request logs and cloudflared.
 * Go is the source of truth; logs are a cache of SQLite, filled live from
 * `webhook:request` events. Never persisted.
 */
interface WebhooksState {
  status: WebhooksStatus;
  error: string | null;
  workspaceId: string | null;
  webhooks: Webhook[];
  /** Running webhooks by statusKey(workspaceId, webhookId). */
  statuses: Record<string, WebhookStatus>;
  logs: Record<string, WebhookLog>;
  /** The last Save problem of each webhook tab (shown on its field). */
  problems: Record<string, WebhookProblem | null>;
  renameTarget: string | null;
  cloudflared: CloudflaredStatus | null;
  install: InstallState;
  /** Webhook waiting for cloudflared (its tab shows the download panel). */
  cloudflaredPrompt: string | null;
  /** The rule open in each webhook tab's rules editor ("" for the default response). */
  selectedRule: Record<string, string>;

  load: () => Promise<void>;
  clear: () => void;
  create: (name?: string) => Promise<Webhook | null>;
  rename: (id: string, name: string) => Promise<void>;
  duplicate: (id: string) => Promise<Webhook | null>;
  remove: (id: string) => Promise<void>;
  setRenameTarget: (id: string | null) => void;
  /** Opens a webhook's tab (of the open workspace, or `workspaceId`'s for a running one). */
  open: (id: string, workspaceId?: string, name?: string) => void;

  loadStatuses: () => Promise<void>;
  start: (id: string, tunnel: boolean) => Promise<WebhookStatus | null>;
  stop: (workspaceId: string, id: string) => Promise<void>;
  handleStatus: (s: WebhookStatus) => void;

  loadLog: (webhookId: string) => Promise<void>;
  loadMore: (webhookId: string) => Promise<void>;
  handleRequest: (webhookId: string, entry: WebhookRequestSummary) => void;
  clearLog: (webhookId: string) => Promise<void>;
  deleteEntry: (webhookId: string, entryId: string) => Promise<void>;
  setProblem: (tabId: string, problem: WebhookProblem | null) => void;

  checkCloudflared: () => Promise<CloudflaredStatus | null>;
  installCloudflared: () => Promise<boolean>;
  cancelInstall: () => Promise<void>;
  pickCloudflared: () => Promise<void>;
  setCloudflaredPath: (path: string) => Promise<void>;
  setInstallProgress: (done: number, total: number) => void;
  setCloudflaredPrompt: (webhookId: string | null) => void;
  selectRule: (tabId: string, ruleId: string) => void;
}

function fail(title: string, e: unknown) {
  toast.error(title, { description: errorMessage(e) });
}

function workspaceId(): string {
  return useWorkspaceStore.getState().workspace?.id ?? "";
}

/** Go saved a new cloudflared path in the settings: keep the settings store in step. */
function syncCloudflaredPath(cf: CloudflaredStatus) {
  useSettingsStore.setState((s) =>
    s.settings.cloudflaredPath === cf.customPath
      ? {}
      : { settings: { ...s.settings, cloudflaredPath: cf.customPath } },
  );
}

function emptyLog(): WebhookLog {
  return { entries: [], loaded: false, loading: false, hasMore: false, error: null };
}

function webhookTabs(wsId: string): Tab[] {
  return useTabsStore.getState().tabs.filter((t) => t.doc?.kind === "webhook" && t.workspaceId === wsId);
}

/** Keeps open webhook tabs in step with the list: names, deletions, external edits. */
function syncTabs(wsId: string, list: Webhook[]) {
  const byId = new Map(list.map((w) => [w.id, w]));
  for (const tab of webhookTabs(wsId)) {
    const w = byId.get(tab.doc!.targetId);
    if (!w) {
      if (isDirty(tab)) {
        if (!tab.doc!.missing) {
          useTabsStore.getState().patchDoc(tab.id, { missing: true });
          toast.warning(`"${tabTitle(tab)}" was deleted`, {
            description: "Your unsaved edits are kept in the tab so you can copy them. It can't be saved.",
          });
        }
      } else {
        useTabsStore.getState().close(tab.id);
      }
      continue;
    }
    const saved = tab.doc!.webhook?.saved;
    if (saved && JSON.stringify(saved) !== JSON.stringify(w)) {
      if (isDirty(tab)) {
        toast.info(`"${tabTitle(tab)}" changed on disk`, {
          description: "Your unsaved edits are kept. Saving replaces the file with your version.",
        });
      }
      useTabsStore.getState().applyWebhookDisk(tab.id, w);
    }
    if (w.name !== tab.doc!.name) useTabsStore.getState().patchDoc(tab.id, { name: w.name });
  }
}

let loadSeq = 0;

export const useWebhooksStore = create<WebhooksState>()((set, get) => ({
  status: "idle",
  error: null,
  workspaceId: null,
  webhooks: [],
  statuses: {},
  logs: {},
  problems: {},
  renameTarget: null,
  cloudflared: null,
  install: { running: false, done: 0, total: 0 },
  cloudflaredPrompt: null,
  selectedRule: {},

  load: async () => {
    const ws = useWorkspaceStore.getState().workspace;
    if (!ws) {
      get().clear();
      return;
    }
    const seq = ++loadSeq;
    if (get().workspaceId !== ws.id) {
      set({ status: "loading", error: null, workspaceId: ws.id, webhooks: [] });
    }
    try {
      const webhooks = await api.listWebhooks();
      if (seq !== loadSeq) return;
      set({ status: "ready", error: null, workspaceId: ws.id, webhooks });
      syncTabs(ws.id, webhooks);
    } catch (e) {
      if (seq !== loadSeq) return;
      set({ status: "error", error: errorMessage(e), workspaceId: ws.id });
    }
  },

  clear: () => {
    loadSeq++;
    set({ status: "idle", error: null, workspaceId: null, webhooks: [] });
  },

  create: async (name = "New webhook") => {
    try {
      const w = await api.createWebhook(name);
      await get().load();
      set({ renameTarget: w.id });
      get().open(w.id);
      return w;
    } catch (e) {
      fail("Couldn't create the webhook", e);
      return null;
    }
  },

  rename: async (id, name) => {
    try {
      await api.renameWebhook(id, name);
      await get().load();
    } catch (e) {
      fail("Couldn't rename the webhook", e);
    }
  },

  duplicate: async (id) => {
    try {
      const w = await api.duplicateWebhook(id);
      await get().load();
      return w;
    } catch (e) {
      fail("Couldn't duplicate the webhook", e);
      return null;
    }
  },

  remove: async (id) => {
    try {
      await api.deleteWebhook(id);
      const tab = webhookTabs(workspaceId()).find((t) => t.doc!.targetId === id);
      if (tab) useTabsStore.getState().close(tab.id);
      set((s) => {
        const logs = { ...s.logs };
        delete logs[id];
        const statuses = { ...s.statuses };
        delete statuses[statusKey(workspaceId(), id)];
        return { logs, statuses };
      });
      await get().load();
    } catch (e) {
      fail("Couldn't delete the webhook", e);
    }
  },

  setRenameTarget: (renameTarget) => set({ renameTarget }),

  open: (id, wsId, name) => {
    const ws = wsId ?? workspaceId();
    const label = name ?? get().webhooks.find((w) => w.id === id)?.name ?? "Webhook";
    useTabsStore.getState().openWebhook(id, label, ws);
  },

  loadStatuses: async () => {
    try {
      const list = await api.webhookStatuses();
      set({ statuses: Object.fromEntries(list.map((s) => [statusKey(s.workspaceId, s.webhookId), s])) });
    } catch {
      // Shown as stopped; the next status event corrects it.
    }
  },

  start: async (id, tunnel) => {
    try {
      const st = await api.startWebhook(id, tunnel);
      get().handleStatus(st);
      return st;
    } catch (e) {
      fail("Couldn't start the webhook", e);
      return null;
    }
  },

  stop: async (wsId, id) => {
    try {
      await api.stopWebhook(wsId, id);
      get().handleStatus({
        ...(get().statuses[statusKey(wsId, id)] ?? {
          workspaceId: wsId,
          webhookId: id,
          name: "",
          workspaceName: "",
          tunnel: false,
          startedAt: "",
        }),
        state: "stopped",
        localUrl: "",
        publicUrl: "",
        message: "",
      });
    } catch (e) {
      fail("Couldn't stop the webhook", e);
    }
  },

  handleStatus: (st) => {
    const key = statusKey(st.workspaceId, st.webhookId);
    set((s) => {
      const statuses = { ...s.statuses };
      if (isRunning(st)) statuses[key] = st;
      else delete statuses[key];
      return { statuses };
    });
  },

  loadLog: async (webhookId) => {
    const cur = get().logs[webhookId];
    if (cur?.loading) return;
    set((s) => ({
      logs: { ...s.logs, [webhookId]: { ...(cur ?? emptyLog()), loading: true, error: null } },
    }));
    try {
      const entries = await api.webhookRequests(webhookId, "", LOG_PAGE);
      set((s) => ({
        logs: {
          ...s.logs,
          [webhookId]: {
            entries,
            loaded: true,
            loading: false,
            hasMore: entries.length === LOG_PAGE,
            error: null,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        logs: {
          ...s.logs,
          [webhookId]: { ...(s.logs[webhookId] ?? emptyLog()), loading: false, error: errorMessage(e) },
        },
      }));
    }
  },

  loadMore: async (webhookId) => {
    const cur = get().logs[webhookId];
    if (!cur?.loaded || cur.loading || !cur.hasMore) return;
    const last = cur.entries[cur.entries.length - 1];
    set((s) => ({ logs: { ...s.logs, [webhookId]: { ...cur, loading: true } } }));
    try {
      const more = await api.webhookRequests(webhookId, last?.id ?? "", LOG_PAGE);
      set((s) => {
        const log = s.logs[webhookId] ?? cur;
        const seen = new Set(log.entries.map((e) => e.id));
        const entries = [...log.entries, ...more.filter((e) => !seen.has(e.id))].slice(0, LOG_CAP);
        return {
          logs: {
            ...s.logs,
            [webhookId]: {
              ...log,
              entries,
              loading: false,
              hasMore: more.length === LOG_PAGE && entries.length < LOG_CAP,
            },
          },
        };
      });
    } catch (e) {
      set((s) => ({ logs: { ...s.logs, [webhookId]: { ...cur, loading: false, error: errorMessage(e) } } }));
    }
  },

  handleRequest: (webhookId, entry) => {
    const log = get().logs[webhookId];
    // Not shown yet: it's read from Go when the log opens.
    if (!log?.loaded) return;
    if (log.entries.some((e) => e.id === entry.id)) return;
    set((s) => ({
      logs: { ...s.logs, [webhookId]: { ...log, entries: [entry, ...log.entries].slice(0, LOG_CAP) } },
    }));
  },

  clearLog: async (webhookId) => {
    try {
      await api.clearWebhookRequests(webhookId);
      set((s) => ({
        logs: {
          ...s.logs,
          [webhookId]: { entries: [], loaded: true, loading: false, hasMore: false, error: null },
        },
      }));
    } catch (e) {
      fail("Couldn't clear the log", e);
    }
  },

  deleteEntry: async (webhookId, entryId) => {
    try {
      await api.deleteWebhookRequest(entryId);
      set((s) => {
        const log = s.logs[webhookId];
        if (!log) return {};
        return {
          logs: { ...s.logs, [webhookId]: { ...log, entries: log.entries.filter((e) => e.id !== entryId) } },
        };
      });
    } catch (e) {
      fail("Couldn't delete the request", e);
    }
  },

  setProblem: (tabId, problem) => set((s) => ({ problems: { ...s.problems, [tabId]: problem } })),

  checkCloudflared: async () => {
    try {
      const cloudflared = await api.cloudflaredStatus();
      set({ cloudflared });
      return cloudflared;
    } catch (e) {
      fail("Couldn't look for cloudflared", e);
      return null;
    }
  },

  installCloudflared: async () => {
    if (get().install.running) return false;
    set({ install: { running: true, done: 0, total: 0 } });
    try {
      const cloudflared = await api.installCloudflared();
      set({ cloudflared, install: { running: false, done: 0, total: 0 } });
      toast.success("cloudflared is installed", { description: `Version ${cloudflared.version}` });
      return true;
    } catch (e) {
      set({ install: { running: false, done: 0, total: 0 } });
      if (errorMessage(e) !== "Cancelled.") fail("Couldn't download cloudflared", e);
      return false;
    }
  },

  cancelInstall: async () => {
    await api.cancelCloudflaredInstall();
  },

  pickCloudflared: async () => {
    try {
      const cloudflared = await api.pickCloudflared();
      syncCloudflaredPath(cloudflared);
      set({ cloudflared });
    } catch (e) {
      fail("Couldn't use that file", e);
    }
  },

  setCloudflaredPath: async (path) => {
    try {
      const cloudflared = await api.setCloudflaredPath(path);
      syncCloudflaredPath(cloudflared);
      set({ cloudflared });
    } catch (e) {
      fail("Couldn't change cloudflared", e);
    }
  },

  setCloudflaredPrompt: (cloudflaredPrompt) => set({ cloudflaredPrompt }),

  selectRule: (tabId, ruleId) => set((s) => ({ selectedRule: { ...s.selectedRule, [tabId]: ruleId } })),

  setInstallProgress: (done, total) =>
    set((s) => (s.install.running ? { install: { running: true, done, total } } : {})),
}));

/** Reset for tests (see resetSidebarStores). */
export function resetWebhooksStore() {
  loadSeq++;
  useWebhooksStore.setState({
    status: "idle",
    error: null,
    workspaceId: null,
    webhooks: [],
    statuses: {},
    logs: {},
    problems: {},
    renameTarget: null,
    cloudflared: null,
    install: { running: false, done: 0, total: 0 },
    cloudflaredPrompt: null,
    selectedRule: {},
  });
}
