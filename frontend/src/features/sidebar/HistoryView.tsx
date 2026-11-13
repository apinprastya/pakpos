import { useEffect, useState } from "react";
import { History, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusTextClass } from "@/features/response/format";
import { plural } from "@/lib/errors";
import { methodShortLabel, methodTextClass } from "@/lib/http";
import type { HistorySummary } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useHistoryStore } from "@/stores/history";
import { ConfirmDeleteDialog, type DeleteTarget } from "./ConfirmDeleteDialog";
import { EmptyState } from "./EmptyState";
import { displayUrl, groupByDay, statusLabel, timeLabel } from "./historyFormat";

export const SEARCH_DEBOUNCE_MS = 250;

export function HistoryView() {
  const items = useHistoryStore((s) => s.items);
  const total = useHistoryStore((s) => s.total);
  const loading = useHistoryStore((s) => s.loading);
  const loaded = useHistoryStore((s) => s.loaded);
  const query = useHistoryStore((s) => s.query);
  const store = useHistoryStore.getState;
  const [input, setInput] = useState(query);
  const [pendingClear, setPendingClear] = useState<DeleteTarget | null>(null);

  useEffect(() => {
    void store().load();
  }, [store]);

  useEffect(() => {
    if (input === store().query) return;
    const timer = setTimeout(() => void store().load(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, store]);

  const now = new Date();
  const groups = groupByDay(items, now);
  const searching = query.trim() !== "";

  const confirmClear = () =>
    setPendingClear({
      title: "Clear all history?",
      description: `This deletes ${plural(total, "entry", "entries")} from every workspace. Saved requests aren't affected.`,
      confirmLabel: "Clear history",
      onConfirm: () => void store().clear(),
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">History</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear history"
              disabled={total === 0}
              onClick={confirmClear}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear history</TooltipContent>
        </Tooltip>
      </div>

      <div className="relative mx-2 mb-1 shrink-0">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label="Search history"
          placeholder="Search by URL, method or name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setInput("")}
          className="h-7 w-full rounded-md border bg-background pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
        />
        {input && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setInput("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {loaded && items.length === 0 ? (
          searching ? (
            <EmptyState title={`No history matches "${query.trim()}"`}>
              <Button size="sm" variant="outline" onClick={() => setInput("")}>
                Clear search
              </Button>
            </EmptyState>
          ) : (
            <EmptyState
              icon={<History className="size-6" />}
              title="No requests sent yet"
              body="Every request you send is listed here, so you can reopen it later."
            />
          )
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h3 className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">{g.label}</h3>
              <ul className="flex flex-col">
                {g.items.map((item) => (
                  <HistoryRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            </section>
          ))
        )}
        {items.length < total && (
          <div className="flex justify-center p-2">
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void store().loadMore()}>
              {loading ? "Loading…" : `Load more (${total - items.length} left)`}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDeleteDialog target={pendingClear} onClose={() => setPendingClear(null)} />
    </div>
  );
}

function HistoryRow({ item, now }: { item: HistorySummary; now: Date }) {
  const store = useHistoryStore.getState;
  const failed = item.status === 0;
  const when = new Date(item.createdAt);
  return (
    <li className="group/row relative mx-1">
      <button
        type="button"
        onClick={() => void store().open(item.id)}
        title={item.url}
        aria-label={`${item.method} ${item.url}, ${statusLabel(item)}, ${timeLabel(when, now)}`}
        className="flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-7 pl-2 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="flex w-full items-center gap-2">
          <span
            className={cn("w-8 shrink-0 font-mono text-[10px] font-semibold", methodTextClass(item.method))}
          >
            {methodShortLabel(item.method)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{displayUrl(item.url)}</span>
        </span>
        <span className="flex items-center gap-2 pl-10 text-[11px]">
          <span
            className={cn(
              "font-mono font-medium",
              failed ? "text-status-server" : statusTextClass(item.status),
              item.errorKind === "canceled" && "text-muted-foreground",
            )}
          >
            {statusLabel(item)}
          </span>
          <time dateTime={item.createdAt} className="text-muted-foreground">
            {timeLabel(when, now)}
          </time>
        </span>
      </button>
      <button
        type="button"
        aria-label="Delete from history"
        title="Delete from history"
        onClick={() => void store().remove(item.id)}
        className="absolute top-1.5 right-1 hidden rounded p-1 text-muted-foreground group-focus-within/row:block group-hover/row:block hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}
