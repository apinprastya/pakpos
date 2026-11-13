import { useState } from "react";
import { FolderOpen, FolderPlus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceStore } from "@/stores/workspace";
import { CollectionTree } from "./CollectionTree";
import { ConfirmDeleteDialog, type DeleteTarget } from "./ConfirmDeleteDialog";
import { EmptyState } from "./EmptyState";
import { ProblemsNotice } from "./ProblemsNotice";
import { filterTree } from "./treeModel";
import { useExpanded } from "./useExpanded";

export function CollectionsView() {
  const status = useWorkspaceStore((s) => s.status);
  const workspace = useWorkspaceStore((s) => s.workspace);

  if (status === "loading") return <EmptyState title="Loading workspace…" />;
  if (!workspace) return <NoWorkspace />;
  return <WorkspaceCollections key={workspace.id} workspaceId={workspace.id} />;
}

function NoWorkspace() {
  const recent = useWorkspaceStore((s) => s.recent);
  const store = useWorkspaceStore.getState;
  return (
    <div className="flex flex-1 flex-col justify-center overflow-auto">
      <EmptyState
        className="flex-none"
        icon={<FolderOpen className="size-6" />}
        title="No workspace open"
        body="Open a folder to keep your requests as files you can commit to git."
      >
        <Button size="sm" onClick={() => void store().openFolder()}>
          <FolderOpen /> Open folder
        </Button>
        <Button size="sm" variant="outline" onClick={() => void store().createInFolder()}>
          <FolderPlus /> Create workspace
        </Button>
      </EmptyState>
      {recent.length > 0 && (
        <section aria-label="Recent workspaces" className="mt-2 border-t px-2 pt-3 pb-3">
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Recent workspaces</h3>
          <ul>
            {recent.slice(0, 5).map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  title={r.path}
                  onClick={() => void store().openPath(r.path)}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="truncate">{r.name || r.path}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{r.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function WorkspaceCollections({ workspaceId }: { workspaceId: string }) {
  const collections = useWorkspaceStore((s) => s.collections);
  const problems = useWorkspaceStore((s) => s.problems);
  const store = useWorkspaceStore.getState;
  const { isExpanded, setExpanded } = useExpanded(workspaceId);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const filtering = query.trim() !== "";
  const shown = filterTree(collections, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Collections</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New collection"
              onClick={() => void store().createCollection()}
            >
              <FolderPlus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New collection</TooltipContent>
        </Tooltip>
      </div>

      {collections.length > 0 && (
        <div className="relative mx-2 mb-1 shrink-0">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Filter requests"
            placeholder="Filter by name, URL or method"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            className="h-7 w-full rounded-md border bg-background pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {filtering && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {collections.length === 0 ? (
          <EmptyState
            title="No collections yet"
            body="A collection groups related requests. Each one is a folder in your workspace."
          >
            <Button size="sm" onClick={() => void store().createCollection()}>
              <FolderPlus /> Create collection
            </Button>
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title={`No requests match "${query.trim()}"`}>
            <Button size="sm" variant="outline" onClick={() => setQuery("")}>
              Clear filter
            </Button>
          </EmptyState>
        ) : (
          <CollectionTree
            collections={shown}
            filtering={filtering}
            isExpanded={isExpanded}
            setExpanded={setExpanded}
            confirmDelete={setPendingDelete}
          />
        )}
      </div>

      <ProblemsNotice problems={problems} />
      <ConfirmDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}
