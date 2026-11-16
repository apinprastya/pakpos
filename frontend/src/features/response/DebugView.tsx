import { useMemo, useRef } from "react";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Copy, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import type { Hop } from "@/lib/model";
import { debugSummary, debugText } from "./debugText";

interface Props {
  /** Empty for a result opened from history, which doesn't keep hops. */
  hops: Hop[];
}

/**
 * The Debug tab: the request as it went over the wire (every header,
 * including the ones the app and Go add, and each redirect followed) and the
 * status line and headers that came back. Secret values are masked.
 */
export function DebugView({ hops }: Props) {
  const view = useRef<EditorView | null>(null);
  const text = useMemo(() => debugText(hops), [hops]);

  if (hops.length === 0) {
    return (
      <div role="status" className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          History doesn&apos;t keep debug details, because they can contain secrets. Send the request again to
          see them.
        </p>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Debug details copied");
    } catch {
      toast.error("Couldn't copy the debug details", { description: "The clipboard isn't available." });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
        <p className="text-xs text-muted-foreground">
          {debugSummary(hops)}. Secret values show as <span className="font-mono">{"{{name}}"}</span>.
        </p>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label="Search in debug details"
            onClick={() => view.current && openSearchPanel(view.current)}
          >
            <Search />
          </IconButton>
          <IconButton label="Copy debug details" onClick={() => void copy()}>
            <Copy />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden border-t">
        <CodeEditor
          ariaLabel="Debug details"
          readOnly
          className="h-full"
          value={text}
          onView={(v) => (view.current = v)}
        />
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
