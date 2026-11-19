import { lazy, Suspense } from "react";
import { loadScripts } from "@/features/shell/dialogChunks";
import type { ScriptsSectionProps } from "./ScriptsSection";

const Section = lazy(() => loadScripts().then((m) => ({ default: m.ScriptsSection })));

/** The Scripts section, loaded on first open so its editor helpers stay out of the startup bundle. */
export function ScriptsSection(props: ScriptsSectionProps) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading scripts…
        </p>
      }
    >
      <Section {...props} />
    </Suspense>
  );
}
