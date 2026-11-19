import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CircleAlert, Copy, Info, Bug, Trash2, TriangleAlert, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConsoleLevel } from "@/lib/model";
import { methodTextClass } from "@/lib/http";
import { modKeyLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { sourceLabel, filterGroups } from "./consoleFilter";
import { CONSOLE_LEVELS, useConsoleStore, type ConsoleGroup, type ConsoleLine } from "@/stores/console";

const LEVEL_LABEL: Record<ConsoleLevel, string> = {
  log: "Log",
  info: "Info",
  warn: "Warnings",
  error: "Errors",
  debug: "Debug",
};

const LEVEL_TEXT: Record<ConsoleLevel, string> = {
  log: "text-foreground",
  info: "text-status-redirect",
  warn: "text-status-client",
  error: "text-destructive",
  debug: "text-muted-foreground",
};

const LEVEL_ICON: Record<ConsoleLevel, typeof Info> = {
  log: ChevronRight,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
  debug: Bug,
};

function time(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The console drawer at the bottom of the app: script output per send. */
export function ConsoleDrawer() {
  const groups = useConsoleStore((s) => s.groups);
  const [levels, setLevels] = useState<ReadonlySet<ConsoleLevel>>(() => new Set(CONSOLE_LEVELS));
  const [search, setSearch] = useState("");
  const visible = useMemo(() => filterGroups(groups, levels, search), [groups, levels, search]);
  const list = useRef<HTMLDivElement>(null);
  const total = groups.reduce((n, g) => n + g.lines.length, 0);

  // Follow new output (instant, so reduced motion is respected).
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const toggleLevel = (level: ConsoleLevel) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  return (
    <section aria-label="Console" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="text-xs font-semibold">Console</h2>
        <div role="group" aria-label="Levels" className="flex items-center gap-0.5">
          {CONSOLE_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={levels.has(level)}
              onClick={() => toggleLevel(level)}
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                levels.has(level) ? "bg-muted text-foreground" : "line-through opacity-70",
              )}
            >
              {LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search the console"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-6 w-44 min-w-0 rounded-sm border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-ring"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={total === 0}
            onClick={() => useConsoleStore.getState().clear()}
          >
            <Trash2 /> Clear
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close console"
                onClick={() => useConsoleStore.getState().setOpen(false)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close console ({modKeyLabel()}+J)</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div ref={list} role="log" aria-label="Console output" className="min-h-0 flex-1 overflow-auto py-1">
        {total === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Script output shows here. Add <code className="font-mono">console.log(…)</code> to a
            request&apos;s Scripts tab, then send it.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No lines match. Turn levels back on or change the search.
          </p>
        ) : (
          visible.map((g) => <Group key={g.sendId} group={g} />)
        )}
      </div>
    </section>
  );
}

function Group({ group }: { group: ConsoleGroup }) {
  return (
    <div
      role="group"
      aria-label={`${group.method} ${group.name}${group.context ? ` (${group.context})` : ""}`}
    >
      <div className="flex items-center gap-2 px-3 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{time(group.startedAt)}</span>
        {group.context && <span className="shrink-0">{group.context}</span>}
        <span className={cn("font-mono font-semibold", methodTextClass(group.method))}>{group.method}</span>
        <span className="truncate text-foreground">{group.name}</span>
        <span>{group.status || "Sending…"}</span>
      </div>
      <ul>
        {group.lines.map((l) => (
          <Line key={l.id} line={l} />
        ))}
      </ul>
    </div>
  );
}

function Line({ line }: { line: ConsoleLine }) {
  const Icon = LEVEL_ICON[line.level];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line.text);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy", { description: "The clipboard isn't available." });
    }
  };
  return (
    <li
      className={cn(
        "group/line flex items-start gap-2 border-b border-border/40 px-3 py-0.5 text-xs",
        line.level === "error" && "bg-destructive/5",
        line.level === "warn" && "bg-status-client/5",
      )}
    >
      <Icon aria-label={line.level} className={cn("mt-0.5 size-3 shrink-0", LEVEL_TEXT[line.level])} />
      <pre
        className={cn(
          "selectable min-w-0 flex-1 font-mono text-[12px] break-words whitespace-pre-wrap",
          LEVEL_TEXT[line.level],
        )}
      >
        {line.text}
      </pre>
      <span className="shrink-0 text-[11px] text-muted-foreground">{sourceLabel(line.source)}</span>
      <button
        type="button"
        aria-label="Copy line"
        title="Copy line"
        onClick={() => void copy()}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/line:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Copy className="size-3" />
      </button>
    </li>
  );
}
