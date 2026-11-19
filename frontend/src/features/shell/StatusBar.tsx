import { ArrowDownToLine, Columns2, Folder, Layers, RotateCw, Rows2, SquareTerminal } from "lucide-react";
import { modKeyLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useConsoleStore } from "@/stores/console";
import { LockIndicator } from "@/features/secrets/SecretsControls";
import { useSelectedEnvironment } from "@/stores/environments";
import { useLayoutStore } from "@/stores/layout";
import { useSettingsStore } from "@/stores/settings";
import { selectUpdateBadge, useUpdateStore } from "@/stores/update";
import { useWorkspaceStore } from "@/stores/workspace";

export function StatusBar() {
  const orientation = useLayoutStore((s) => s.splitOrientation);
  const setLayout = useSettingsStore((s) => s.setLayout);
  const toggle = () => void setLayout(orientation === "vertical" ? "horizontal" : "vertical");
  const workspace = useWorkspaceStore((s) => s.workspace);
  const environment = useSelectedEnvironment();
  const nextLabel =
    orientation === "vertical" ? "Show response beside request" : "Show response below request";

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5" title={workspace?.path}>
        {workspace && <Folder className="size-3 shrink-0" aria-hidden />}
        <span className="truncate">{workspace ? workspace.name : "No workspace"}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {workspace && (
          <button
            type="button"
            title="Manage environments"
            aria-label={`Environment: ${environment?.name ?? "none"}. Manage environments`}
            onClick={() => useLayoutStore.getState().setSidebarView("environments")}
            className="flex max-w-48 items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Layers aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{environment?.name ?? "No environment"}</span>
          </button>
        )}
        <UpdateIndicator />
        <LockIndicator />
        <ConsoleToggle />
        <button
          type="button"
          onClick={toggle}
          aria-label={nextLabel}
          title={nextLabel}
          className="flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {orientation === "vertical" ? <Rows2 className="size-3.5" /> : <Columns2 className="size-3.5" />}
        </button>
      </span>
    </footer>
  );
}

/** Shown while a new release waits to be installed, or installed and waiting for a restart. */
function UpdateIndicator() {
  const badge = useUpdateStore(selectUpdateBadge);
  const latest = useUpdateStore((s) => s.info?.latest);
  if (!badge) return null;
  const label = badge === "installed" ? "Restart to update" : "Update available";
  const Icon = badge === "installed" ? RotateCw : ArrowDownToLine;
  return (
    <button
      type="button"
      title={`Pakpos ${latest}`}
      onClick={() => useUpdateStore.getState().openDialog()}
      className="flex items-center gap-1 rounded px-1 text-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {label}
    </button>
  );
}

/** Shows or hides the console drawer; counts lines logged while it's hidden. */
function ConsoleToggle() {
  const open = useConsoleStore((s) => s.open);
  const unread = useConsoleStore((s) => s.unread);
  const action = open ? "Hide console" : "Show console";
  const label = !open && unread > 0 ? `${action} (${unread} new ${unread === 1 ? "line" : "lines"})` : action;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={`${action} (${modKeyLabel()}+J)`}
      onClick={() => useConsoleStore.getState().toggle()}
      className={cn(
        "flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        open && "text-foreground",
      )}
    >
      <SquareTerminal aria-hidden className="size-3.5" />
      Console
      {!open && unread > 0 && (
        <span className="rounded-sm bg-primary px-1 text-[10px] text-primary-foreground tabular-nums">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
