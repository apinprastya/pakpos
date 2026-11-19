import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/features/response/format";
import type { RunListItem, RunOutcome } from "@/lib/runModel";
import { cn } from "@/lib/utils";
import { useRunnerStore } from "@/stores/runner";
import { runTime } from "./format";

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  stopped: "Stopped",
  canceled: "Cancelled",
  error: "Error",
};

interface Props {
  /** Runs to list (the store's list, for this target). */
  runs: RunListItem[];
  shownId: string | null;
  onOpen: (runId: string) => void;
}

/** Stored runs of the target, newest first: open or delete. */
export function PastRuns({ runs, shownId, onOpen }: Props) {
  const status = useRunnerStore((s) => s.pastStatus);
  const error = useRunnerStore((s) => s.pastError);
  if (status === "error") {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-xs">
        <p className="text-destructive">Couldn&apos;t load past runs: {error}</p>
        <Button size="sm" variant="outline" onClick={() => void useRunnerStore.getState().loadPast()}>
          Try again
        </Button>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <p role="status" className="p-6 text-center text-xs text-muted-foreground">
        {status === "loading"
          ? "Loading past runs…"
          : "No past runs yet. The last 20 runs of this workspace are kept here."}
      </p>
    );
  }
  return (
    <ul aria-label="Past runs" className="overflow-auto">
      {runs.map((r) => {
        const t = r.totals;
        const failed = t.testsFailed + t.errors;
        return (
          <li
            key={r.id}
            className={cn("group/run flex items-center border-b", shownId === r.id && "bg-muted/40")}
          >
            <button
              type="button"
              onClick={() => onOpen(r.id)}
              aria-current={shownId === r.id ? "true" : undefined}
              className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left text-xs hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none"
            >
              <span className="w-28 shrink-0 tabular-nums">{runTime(r.createdAt)}</span>
              <span
                className={cn(
                  "w-16 shrink-0",
                  r.outcome === "passed"
                    ? "text-status-ok"
                    : failed
                      ? "text-status-server"
                      : "text-muted-foreground",
                )}
              >
                {OUTCOME_LABEL[r.outcome]}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {r.environmentName || "No environment"} · {r.iterations}{" "}
                {r.iterations === 1 ? "iteration" : "iterations"}
                {r.dataFile && ` · ${r.dataFile}`}
              </span>
              <span className="shrink-0 tabular-nums">
                {t.requests} requests · {t.testsPassed} passed · {t.testsFailed} failed · {t.errors} errors
              </span>
              <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
                {formatDuration(r.durationMs)}
              </span>
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="mr-2 text-muted-foreground"
              aria-label={`Delete the run of ${runTime(r.createdAt)}`}
              title="Delete run"
              onClick={() => void useRunnerStore.getState().removePast(r.id)}
            >
              <Trash2 />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
