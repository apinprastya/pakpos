import { useState } from "react";
import { BookmarkPlus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusTextClass } from "@/features/response/format";
import { ConfirmDeleteDialog, type DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import { InlineRename } from "@/features/sidebar/InlineRename";
import type { ExampleSummary } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useExamplesStore, useRequestExamples } from "@/stores/examples";
import type { Tab } from "@/stores/tabs";
import { savedLabel } from "./saveState";

/** The "Examples" tab of a request: saved responses to open, rename or delete. */
export function ExamplesSection({ tab }: { tab: Tab }) {
  const requestId = tab.saved?.id ?? "";
  const examples = useRequestExamples(requestId);
  const viewingId = useExamplesStore((s) => s.viewing[tab.id]?.id ?? "");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const store = useExamplesStore.getState;

  if (!requestId) {
    return (
      <Empty>
        Save the request to keep examples of its responses. They&apos;re stored in a file next to the request.
      </Empty>
    );
  }
  if (examples.length === 0) {
    return (
      <Empty>
        No examples yet. Send the request, then choose{" "}
        <BookmarkPlus aria-hidden className="inline size-3.5" /> &ldquo;Save as example&rdquo; in the response
        to keep it here.
      </Empty>
    );
  }

  const confirmDelete = (e: ExampleSummary) =>
    setPendingDelete({
      title: `Delete example "${e.name}"?`,
      description: "This removes the saved response from the request's examples file.",
      confirmLabel: "Delete example",
      onConfirm: () => {
        store().hide(tab.id);
        void store().remove(requestId, e.id);
      },
    });

  return (
    <>
      <ul aria-label="Examples" className="flex flex-col gap-0.5">
        {examples.map((e) => {
          const active = e.id === viewingId;
          return (
            <li
              key={e.id}
              className={cn(
                "group/ex flex h-8 items-center gap-2 rounded-md pr-1 pl-2 hover:bg-muted",
                active && "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              <span
                className={cn("w-9 shrink-0 font-mono text-xs font-semibold", statusTextClass(e.statusCode))}
              >
                {e.statusCode || "—"}
              </span>
              {renaming === e.id ? (
                <InlineRename
                  initial={e.name}
                  label="Example name"
                  onCommit={(name) => {
                    setRenaming(null);
                    void store().rename(requestId, e.id, name);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Open example ${e.name}`}
                  aria-current={active || undefined}
                  onClick={() => void store().show(tab.id, requestId, e.id)}
                  onDoubleClick={() => setRenaming(e.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <time dateTime={e.savedAt} className="shrink-0 text-xs text-muted-foreground">
                    {savedLabel(e.savedAt)}
                  </time>
                </button>
              )}
              <RowButton
                label={`Rename example ${e.name}`}
                tooltip="Rename"
                onClick={() => setRenaming(e.id)}
              >
                <Pencil />
              </RowButton>
              <RowButton label={`Delete example ${e.name}`} tooltip="Delete" onClick={() => confirmDelete(e)}>
                <Trash2 />
              </RowButton>
            </li>
          );
        })}
      </ul>
      <ConfirmDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </>
  );
}

function RowButton({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="opacity-0 group-focus-within/ex:opacity-100 group-hover/ex:opacity-100 focus-visible:opacity-100"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="max-w-md py-2 text-sm text-muted-foreground">{children}</p>;
}
