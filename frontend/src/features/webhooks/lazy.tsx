import { lazy, Suspense } from "react";
import { loadWebhooks } from "@/features/shell/dialogChunks";
import type { Tab } from "@/stores/tabs";

const View = lazy(() => loadWebhooks().then((m) => ({ default: m.WebhookView })));

/** A webhook tab, loaded on first open so the webhook UI stays out of the startup bundle. */
export function WebhookView({ tab }: { tab: Tab }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading the webhook…
        </p>
      }
    >
      <View tab={tab} />
    </Suspense>
  );
}
