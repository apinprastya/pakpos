import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { cn } from "@/lib/utils";
import { TOOLS } from "./registry";

/** The "Tools" sidebar view: every tool from the registry; a click opens its tab. */
export function ToolsSidebar() {
  const active = useActiveTab();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Tools</h2>
      </div>
      <ul aria-label="Tools" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const open = active.tool?.id === t.id;
          return (
            <li key={t.id} className="mx-1">
              <button
                type="button"
                aria-current={open ? "page" : undefined}
                onClick={() => useTabsStore.getState().openTool(t.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  open && "bg-sidebar-accent",
                )}
              >
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm">{t.label}</span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="shrink-0 border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        Pick a tool to open it in a tab. What you paste into a tool stays on this device.
      </p>
    </div>
  );
}
