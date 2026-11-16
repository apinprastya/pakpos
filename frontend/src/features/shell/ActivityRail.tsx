import { FolderTree, History, Layers, Search, Settings, type LucideIcon } from "lucide-react";
import { usePaletteStore } from "@/stores/palette";
import { Button } from "@/components/ui/button";
import { modKeyLabel } from "@/lib/platform";
import { useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLayoutStore, type SidebarView } from "@/stores/layout";
import { ThemeMenu } from "./ThemeMenu";
import { TitleBarSpace } from "./TitleBarSpace";
import { AppLogo } from "./AppLogo";

const VIEWS: { id: SidebarView; label: string; icon: LucideIcon }[] = [
  { id: "collections", label: "Collections", icon: FolderTree },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "history", label: "History", icon: History },
];

export function ActivityRail() {
  const view = useLayoutStore((s) => s.sidebarView);
  const setView = useLayoutStore((s) => s.setSidebarView);

  return (
    <nav
      aria-label="Sidebar views"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2 mac:pt-0"
    >
      <TitleBarSpace className="-mr-px mb-1 w-[calc(100%+1px)] self-start" />
      <AppLogo className="mb-2" />
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
      <div className="mt-auto flex flex-col items-center gap-1">
        <PaletteButton />
        <SettingsButton />
        <ThemeMenu />
      </div>
    </nav>
  );
}

function PaletteButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Command palette"
          onClick={() => usePaletteStore.getState().openPalette()}
        >
          <Search />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Command palette <span className="ml-1 text-muted-foreground">{modKeyLabel()}+K</span>
      </TooltipContent>
    </Tooltip>
  );
}

function SettingsButton() {
  const open = useSettingsStore((s) => s.openDialog);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => open()}>
          <Settings />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Settings <span className="ml-1 text-muted-foreground">{modKeyLabel()}+,</span>
      </TooltipContent>
    </Tooltip>
  );
}
