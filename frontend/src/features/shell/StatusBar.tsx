import { Columns2, Folder, Layers, Rows2 } from "lucide-react";
import { LockIndicator } from "@/features/secrets/SecretsControls";
import { useSelectedEnvironment } from "@/stores/environments";
import { useLayoutStore } from "@/stores/layout";
import { useSettingsStore } from "@/stores/settings";
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
        <LockIndicator />
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
