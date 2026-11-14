import { Button } from "@/components/ui/button";
import { openContainerSettings } from "@/features/scopes/docActions";
import type { InheritSource } from "@/lib/model";
import { AUTH_LABELS } from "./auth";
import type { PreviewState } from "./usePreview";

function SourceLink({ source }: { source: InheritSource }) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto max-w-full justify-start truncate p-0 text-xs text-muted-foreground hover:text-foreground"
      aria-label={`Open ${source.name} settings`}
      title={`Open ${source.kind} settings`}
      onClick={() => openContainerSettings(source.id)}
    >
      <span className="truncate">{source.name}</span>
    </Button>
  );
}

/** What `inherit` resolves to, and where it comes from (with a link there). */
export function InheritedAuth({
  state,
  hasParent,
  subject,
}: {
  state: PreviewState;
  hasParent: boolean;
  subject: string;
}) {
  let body: React.ReactNode;
  if (!hasParent) {
    body = `This ${subject} isn't in a collection, so there's nothing to inherit. No auth is sent.`;
  } else if (state.error) {
    body = `Couldn't check the inherited auth: ${state.error}`;
  } else if (!state.preview) {
    body = "Checking the inherited auth…";
  } else if (state.preview.authSource) {
    const src = state.preview.authSource;
    body = (
      <span className="flex flex-wrap items-center gap-x-1">
        Uses <span className="text-foreground">{AUTH_LABELS[state.preview.auth.type]}</span> from the{" "}
        {src.kind} <SourceLink source={src} />
      </span>
    );
  } else {
    body = "No auth is set on the collection or its folders, so none is sent.";
  }
  return (
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
      {body}
    </p>
  );
}

/** Read-only list of the headers the request inherits, with their source. */
export function InheritedHeaders({ state }: { state: PreviewState }) {
  const headers = state.preview?.headers ?? [];
  return (
    <section aria-labelledby="inherited-headers-title">
      <h3 id="inherited-headers-title" className="mb-1 text-xs font-medium text-muted-foreground">
        Inherited
      </h3>
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn&apos;t check inherited headers: {state.error}
        </p>
      ) : headers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {state.preview
            ? "None. Headers set on the collection or its folders show up here."
            : "Checking inherited headers…"}
        </p>
      ) : (
        <ul aria-label="Inherited headers" className="divide-y divide-border/60 rounded-md border">
          {headers.map((h, i) => (
            <li
              key={`${h.source.id}-${h.key}-${i}`}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,1.5fr)] items-center gap-2 px-3 py-1 text-[12px] text-muted-foreground"
            >
              <span className="truncate font-mono">{h.key}</span>
              <span className="selectable truncate font-mono">{h.value}</span>
              <span className="flex min-w-0 items-center gap-1 text-xs">
                <span className="shrink-0">from</span>
                <SourceLink source={h.source} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
