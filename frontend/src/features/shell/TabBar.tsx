import { methodShortLabel, methodTextClass } from "@/lib/http";
import { cn } from "@/lib/utils";

export interface TabInfo {
  id: string;
  title: string;
  method: string;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeId: string;
}

/** Request tabs. Opening, closing and reordering arrive in M4. */
export function TabBar({ tabs, activeId }: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Open requests"
      className="flex h-10 shrink-0 items-end border-b bg-sidebar"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={cn(
              "-mb-px flex h-full max-w-56 items-center gap-2 border-r px-3 text-sm",
              active ? "border-b border-b-background bg-background text-foreground" : "text-muted-foreground",
            )}
          >
            <span className={cn("font-mono text-[11px] font-semibold", methodTextClass(tab.method))}>
              {methodShortLabel(tab.method)}
            </span>
            <span className="truncate">{tab.title}</span>
          </div>
        );
      })}
    </div>
  );
}
