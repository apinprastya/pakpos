import { Check, ChevronsUpDown, FolderOpen, FolderPlus, X, XCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";

/** Sidebar header: shows the open workspace and switches between workspaces. */
export function WorkspaceSwitcher() {
  const status = useWorkspaceStore((s) => s.status);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const recent = useWorkspaceStore((s) => s.recent);
  const store = useWorkspaceStore.getState;

  const label = status === "loading" ? "Loading…" : (workspace?.name ?? "No workspace");

  return (
    <DropdownMenu onOpenChange={(open) => open && void store().loadRecent()}>
      <DropdownMenuTrigger
        aria-label={`Workspace: ${label}. Switch workspace`}
        title={workspace?.path}
        className="flex h-10 w-full shrink-0 items-center gap-2 border-b px-3 text-left hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
      >
        <span className={cn("min-w-0 flex-1 truncate font-semibold", !workspace && "text-muted-foreground")}>
          {label}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {recent.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Recent workspaces</DropdownMenuLabel>
            {recent.slice(0, 8).map((r) => {
              const current = r.path === workspace?.path;
              return (
                <DropdownMenuItem
                  key={r.path}
                  onSelect={() => !current && void store().openPath(r.path)}
                  className="group/recent pr-1"
                  title={r.path}
                >
                  <Check className={cn("size-3.5", !current && "invisible")} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{r.name || r.path}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{r.path}</span>
                  </span>
                  {!current && (
                    <button
                      type="button"
                      aria-label={`Remove ${r.name || r.path} from recent workspaces`}
                      title="Remove from recent"
                      // Keep the menu item from also selecting (and opening) this workspace.
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void store().removeRecent(r.path);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="invisible rounded p-1 text-muted-foreground group-hover/recent:visible group-focus/recent:visible hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => void store().openFolder()}>
          <FolderOpen /> Open folder…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void store().createInFolder()}>
          <FolderPlus /> Create workspace…
        </DropdownMenuItem>
        {workspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void store().close()}>
              <XCircle /> Close workspace
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
