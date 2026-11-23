import { useEffect } from "react";
import { api } from "@/lib/api";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Keeps the webhooks store live: running statuses and logged requests from
 * Go's events, download progress, and the list reloaded when the workspace
 * opens or its files change outside the app.
 */
export function useWebhooksSync(): void {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id ?? null);

  useEffect(() => {
    const store = useWebhooksStore.getState;
    const offs = [
      api.onWebhookStatus((s) => store().handleStatus(s)),
      api.onWebhookRequest((ev) => store().handleRequest(ev.webhookId, ev.entry)),
      api.onCloudflaredInstall((p) => store().setInstallProgress(p.done, p.total)),
      api.onWorkspaceChanged((change) => {
        if (change.workspaceId === useWorkspaceStore.getState().workspace?.id) void store().load();
      }),
    ];
    void store().loadStatuses();
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    void useWebhooksStore.getState().load();
  }, [workspaceId]);
}
