import { useWebhooksStore } from "@/stores/webhooks";

/**
 * Starts a webhook of the open workspace. With a tunnel, cloudflared is
 * checked first: when it's missing, the webhook's tab opens on the download
 * panel instead (nothing starts). Resolves true when it started.
 */
export async function startWebhook(id: string, tunnel: boolean): Promise<boolean> {
  const store = useWebhooksStore.getState();
  if (tunnel) {
    const cf = await store.checkCloudflared();
    if (!cf) return false;
    if (!cf.found) {
      store.open(id);
      store.setCloudflaredPrompt(id);
      return false;
    }
  }
  store.setCloudflaredPrompt(null);
  return (await store.start(id, tunnel)) !== null;
}
