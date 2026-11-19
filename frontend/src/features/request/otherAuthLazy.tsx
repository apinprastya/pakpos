import { lazy, Suspense } from "react";
import { loadOtherAuth } from "@/features/shell/dialogChunks";
import type { OtherAuthFieldsProps } from "./OtherAuthFields";

const Fields = lazy(() => loadOtherAuth().then((m) => ({ default: m.OtherAuthFields })));

/** The fields of the less common auth types, loaded on first use. */
export function OtherAuthFields(props: OtherAuthFieldsProps) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-xs text-muted-foreground">
          Loading…
        </p>
      }
    >
      <Fields {...props} />
    </Suspense>
  );
}
