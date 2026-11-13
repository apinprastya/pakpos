import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { methodShortLabel, methodTextClass } from "@/lib/http";
import { modKeyLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { isDirty, tabTitle, useTabsStore } from "@/stores/tabs";

/** Open request tabs: click to switch, middle-click or × to close, drag to reorder. */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const { activate, requestClose, move, newTab } = useTabsStore.getState();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div className="flex h-10 shrink-0 items-end border-b bg-sidebar">
      <div
        role="tablist"
        aria-label="Open requests"
        className="flex h-full min-w-0 [scrollbar-width:none] items-end overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const dirty = isDirty(tab);
          const title = tabTitle(tab);
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(tab.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) move(dragId, tab.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) requestClose(tab.id);
              }}
              className={cn(
                "group relative -mb-px flex h-full max-w-56 min-w-28 shrink-0 items-center border-r",
                active
                  ? "border-b border-b-background bg-background text-foreground"
                  : "text-muted-foreground",
                overId === tab.id && dragId !== tab.id && "bg-accent",
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.request.url || title}
                onClick={() => activate(tab.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
              >
                <span
                  className={cn("font-mono text-[11px] font-semibold", methodTextClass(tab.request.method))}
                >
                  {methodShortLabel(tab.request.method)}
                </span>
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={dirty ? `Close ${title} (unsaved changes)` : `Close ${title}`}
                onClick={() => requestClose(tab.id)}
                className="relative mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {dirty && (
                  <span
                    aria-hidden
                    className="absolute size-2 rounded-full bg-foreground/70 group-focus-within:hidden group-hover:hidden"
                  />
                )}
                <X
                  className={cn(
                    "size-3.5",
                    dirty && "invisible group-focus-within:visible group-hover:visible",
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New request"
            onClick={() => newTab()}
            className="mx-1 mb-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Plus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>New request ({modKeyLabel()}+T)</TooltipContent>
      </Tooltip>
    </div>
  );
}
