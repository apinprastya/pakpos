import { FolderTree, History, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLayoutStore, type SidebarView } from "@/stores/layout";
import { ThemeMenu } from "./ThemeMenu";

const VIEWS: { id: SidebarView; label: string; icon: LucideIcon }[] = [
  { id: "collections", label: "Collections", icon: FolderTree },
  { id: "history", label: "History", icon: History },
];

export function ActivityRail() {
  const view = useLayoutStore((s) => s.sidebarView);
  const setView = useLayoutStore((s) => s.setSidebarView);

  return (
    <nav
      aria-label="Sidebar views"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2"
    >
      <Logo />
      {VIEWS.map(({ id, label, icon: Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                view === id &&
                  "text-foreground before:absolute before:top-2 before:bottom-2 before:-left-1.5 before:w-0.5 before:rounded-full before:bg-primary",
              )}
            >
              <Icon className="size-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
      <div className="mt-auto">
        <ThemeMenu />
      </div>
    </nav>
  );
}

/** A postage-stamp mark: perforated square with a "P". */
function Logo() {
  return (
    <div
      aria-hidden
      className="mb-2 flex size-8 items-center justify-center rounded-[3px] bg-primary font-mono text-sm font-bold text-primary-foreground outline-2 outline-offset-2 outline-primary outline-dashed"
    >
      P
    </div>
  );
}
