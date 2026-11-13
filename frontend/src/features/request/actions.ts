import { toast } from "sonner";
import { api } from "@/lib/api";
import { compactRequest, type SendResult } from "@/lib/model";
import { useHistoryStore } from "@/stores/history";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

function newSendId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Sends the tab's request. Network failures arrive in the result, not as throws. */
export async function sendTab(tabId: string): Promise<void> {
  const store = useTabsStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab || tab.sendId || !tab.request.url.trim()) return;

  const sendId = newSendId();
  store.setSending(tabId, sendId);
  let result: SendResult;
  try {
    result = await api.send(sendId, compactRequest(tab.request));
  } catch (e) {
    result = { response: null, error: { kind: "network", message: errorMessage(e) }, historyId: 0 };
  }
  // Ignore results for tabs that were closed or re-sent meanwhile.
  const current = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (current?.sendId === sendId) useTabsStore.getState().setResult(tabId, result);
  if (result.historyId) void useHistoryStore.getState().refresh();
}

export async function cancelTab(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.sendId) return;
  try {
    await api.cancel(tab.sendId);
  } catch (e) {
    toast.error("Couldn't cancel the request", { description: errorMessage(e) });
  }
}

/**
 * Saves the tab. A request that was saved before is overwritten in place;
 * a new one opens the Save dialog. Resolves true when it saved right away.
 */
export async function saveTab(tabId: string, closeAfter = false): Promise<boolean> {
  const store = useTabsStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  if (!tab.saved || !tab.request.id) {
    store.openSaveDialog(tabId, closeAfter);
    return false;
  }
  try {
    const saved = await api.save(compactRequest(tab.request));
    useTabsStore.getState().markSaved(tabId, saved);
    if (closeAfter) useTabsStore.getState().close(tabId);
    toast.success("Request saved");
    void useWorkspaceStore.getState().refresh();
    return true;
  } catch (e) {
    toast.error("Couldn't save the request", { description: errorMessage(e) });
    return false;
  }
}

/** Saves a new request into a collection (used by the Save dialog). */
export async function saveTabAs(tabId: string, collectionId: string, name: string): Promise<boolean> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  try {
    const saved = await api.saveAs(collectionId, name, compactRequest({ ...tab.request, name }));
    const workspaceId = useWorkspaceStore.getState().workspace?.id ?? "";
    useTabsStore.getState().markSaved(tabId, saved, collectionId, workspaceId);
    toast.success("Request saved");
    void useWorkspaceStore.getState().refresh();
    return true;
  } catch (e) {
    toast.error("Couldn't save the request", { description: errorMessage(e) });
    return false;
  }
}

export async function pickFile(): Promise<string> {
  try {
    return await api.pickFile();
  } catch (e) {
    toast.error("Couldn't open the file picker", { description: errorMessage(e) });
    return "";
  }
}

export async function saveResponseBody(historyId: number): Promise<void> {
  try {
    const path = await api.saveResponseBody(historyId);
    if (path) toast.success("Response saved", { description: path });
  } catch (e) {
    toast.error("Couldn't save the response", { description: errorMessage(e) });
  }
}
