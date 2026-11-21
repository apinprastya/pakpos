import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { compactWebhook } from "@/lib/webhookModel";
import { tabTitle, useTabsStore } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";

/** Loads a webhook tab that has no draft yet. Rejects with Go's error so the view can show it. */
export async function loadWebhookTab(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.doc?.webhook) return;
  const w = await api.getWebhook(tab.doc.targetId);
  useTabsStore.getState().markWebhookSaved(tabId, w);
}

/**
 * Saves a webhook tab. A webhook that doesn't validate isn't written: its
 * problem is kept for the view to show on the field. Resolves true on success.
 */
export async function saveWebhookTab(tabId: string, closeAfter = false): Promise<boolean> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  const doc = tab?.doc;
  const draft = doc?.webhook?.draft;
  if (!tab || !doc || !draft) return false;
  if (doc.missing) {
    toast.error(`Couldn't save ${tabTitle(tab)}`, {
      description: "It was deleted outside the app. Copy your changes elsewhere, then close the tab.",
    });
    return false;
  }
  const store = useWebhooksStore.getState();
  try {
    const res = await api.saveWebhook(compactWebhook(draft));
    if (res.problem || !res.webhook) {
      store.setProblem(tabId, res.problem);
      toast.error(`Couldn't save ${tabTitle(tab)}`, { description: res.problem?.message });
      return false;
    }
    store.setProblem(tabId, null);
    useTabsStore.getState().markWebhookSaved(tabId, res.webhook);
    if (closeAfter) useTabsStore.getState().close(tabId);
    toast.success(`${res.webhook.name} saved`);
    void store.load();
    return true;
  } catch (e) {
    toast.error(`Couldn't save ${tabTitle(tab)}`, { description: errorMessage(e) });
    return false;
  }
}

/** Copies text and confirms it with a toast. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch (e) {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`, { description: errorMessage(e) });
  }
}
