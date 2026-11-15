import { useState } from "react";
import { Pencil } from "lucide-react";
import { InlineRename } from "@/features/sidebar/InlineRename";
import { ancestorsOf, findRequest } from "@/lib/tree";
import { tabTitle, useTabsStore, type Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The request's name above the URL bar, with the collection and folders it
 * lives in. Click the name to rename it: a saved request is renamed on disk
 * (like the sidebar's Rename), an unsaved one just changes its draft name.
 */
export function RequestTitle({ tab }: { tab: Tab }) {
  const [renaming, setRenaming] = useState(false);
  const collections = useWorkspaceStore((s) => s.collections);
  const savedId = tab.saved?.id ?? "";
  const inTree = savedId !== "" && findRequest(collections, savedId) !== undefined;
  // A saved request that isn't in the open workspace can't be renamed from here.
  const canRename = savedId === "" || inTree;
  const path = inTree ? ancestorsOf(collections, "request", savedId).map((c) => c.name) : [];
  const title = tabTitle(tab);

  const commit = (name: string) => {
    setRenaming(false);
    if (savedId) void useWorkspaceStore.getState().renameRequest(savedId, name);
    else useTabsStore.getState().updateRequest(tab.id, (r) => ({ ...r, name }));
  };

  return (
    <div className="flex h-8 shrink-0 items-end gap-1 px-4 text-sm">
      {path.length > 0 && (
        <span className="min-w-0 shrink truncate text-muted-foreground" title={path.join(" / ")}>
          {path.join(" / ")} /
        </span>
      )}
      {renaming ? (
        <div className="flex h-6 max-w-80 min-w-40 flex-1">
          <InlineRename
            initial={tab.request.name}
            label="Request name"
            onCommit={commit}
            onCancel={() => setRenaming(false)}
          />
        </div>
      ) : canRename ? (
        <button
          type="button"
          aria-label={`Rename request ${title}`}
          title="Rename request"
          onClick={() => setRenaming(true)}
          className="group/title flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{title}</span>
          <Pencil
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
          />
        </button>
      ) : (
        <span className="truncate px-1 font-semibold">{title}</span>
      )}
    </div>
  );
}
