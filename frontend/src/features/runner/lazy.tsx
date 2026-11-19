import { lazy, Suspense } from "react";
import { loadRunner } from "@/features/shell/dialogChunks";
import type { Tab } from "@/stores/tabs";

const View = lazy(() => loadRunner().then((m) => ({ default: m.RunnerView })));

/** The runner tab, loaded on first open so the runner UI stays out of the startup bundle. */
export function RunnerView({ tab }: { tab: Tab }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading the runner…
        </p>
      }
    >
      <View tab={tab} />
    </Suspense>
  );
}
