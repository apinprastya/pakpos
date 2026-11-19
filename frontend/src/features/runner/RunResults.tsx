import { useState } from "react";
import { ChevronRight, CircleCheck, CircleMinus, CircleX, Download, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDuration, statusTextClass } from "@/features/response/format";
import { methodTextClass } from "@/lib/http";
import { resultFailed, testCounts, type RunOutcome, type RunResult } from "@/lib/runModel";
import { cn } from "@/lib/utils";
import { resultStatus, useRunnerStore, type RunState } from "@/stores/runner";

/** The most result rows rendered at once; the export has every one. */
export const MAX_ROWS = 500;

type Filter = "all" | "failed";

const OUTCOME_TEXT: Record<RunOutcome, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Finished with failures",
  stopped: "Stopped at the first failure",
  canceled: "Cancelled",
  error: "Stopped with an error",
};

const OUTCOME_CLASS: Record<RunOutcome, string> = {
  running: "text-muted-foreground",
  passed: "text-status-ok",
  failed: "text-status-server",
  stopped: "text-status-server",
  canceled: "text-status-client",
  error: "text-status-server",
};

interface Props {
  run: RunState;
  onRunAgain: () => void;
  canRunAgain: boolean;
}

/** A live or stored run: progress or summary, actions and the results list. */
export function RunResults({ run, onRunAgain, canRunAgain }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const { report, done } = run;
  const results = report.results;
  const failedCount = results.filter(resultFailed).length;
  const shown = filter === "failed" ? results.filter(resultFailed) : results;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        {done ? <Summary run={run} /> : <Progress run={run} />}
        <div className="flex flex-wrap items-center gap-2">
          {done ? (
            <>
              <Button size="sm" variant="outline" disabled={!canRunAgain} onClick={onRunAgain}>
                <RotateCcw /> Run again
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void useRunnerStore.getState().exportRun(report.id, "json")}
              >
                <Download /> Export JSON
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void useRunnerStore.getState().exportRun(report.id, "html")}
              >
                <Download /> Export HTML
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void useRunnerStore.getState().cancel(report.id)}
            >
              <Square /> Cancel
            </Button>
          )}
          <span className="flex-1" />
          <div role="radiogroup" aria-label="Show results" className="flex rounded-md border p-0.5">
            {(["all", "failed"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-sm px-2 py-0.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  filter === f ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "all" ? `All ${results.length}` : `Failed ${failedCount}`}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <p role="status" className="p-6 text-center text-xs text-muted-foreground">
            {filter === "failed"
              ? "Nothing failed."
              : done
                ? "No requests ran."
                : "Waiting for the first response…"}
          </p>
        ) : (
          <ul aria-label="Run results">
            {shown.slice(0, MAX_ROWS).map((r, i) => (
              <ResultRow key={`${r.iteration}:${r.index}:${i}`} result={r} iterations={report.iterations} />
            ))}
          </ul>
        )}
        {shown.length > MAX_ROWS && (
          <p className="p-3 text-xs text-muted-foreground">
            Showing the first {MAX_ROWS} of {shown.length} results. Export the report to see all of them.
          </p>
        )}
      </div>
    </div>
  );
}

function Progress({ run }: { run: RunState }) {
  const { report, current } = run;
  const perIteration = report.requests.length || 1;
  const total = perIteration * Math.max(report.iterations, 1);
  const finished = report.results.length;
  const pct = Math.min(100, Math.round((finished / total) * 100));
  const request = current ? report.requests[current.index] : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">Running {report.target.name}</span>
        <span className="text-muted-foreground" aria-live="polite">
          {current
            ? `Iteration ${current.iteration + 1} of ${report.iterations}${request ? ` · ${request.name}` : ""}`
            : "Starting…"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Summary({ run }: { run: RunState }) {
  const { report } = run;
  const s = report.summary;
  const stats: { label: string; value: string; className?: string }[] = [
    { label: "Requests", value: String(s.requests) },
    {
      label: "Passed",
      value: String(s.testsPassed),
      className: s.testsPassed ? "text-status-ok" : undefined,
    },
    {
      label: "Failed",
      value: String(s.testsFailed),
      className: s.testsFailed ? "text-status-server" : undefined,
    },
    { label: "Errors", value: String(s.errors), className: s.errors ? "text-status-server" : undefined },
    { label: "Skipped", value: String(s.skipped) },
    { label: "Duration", value: formatDuration(s.durationMs) },
    { label: "Avg response", value: formatDuration(s.avgResponseMs) },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs">
        <span className={cn("font-medium", OUTCOME_CLASS[report.outcome])}>
          {OUTCOME_TEXT[report.outcome]}
        </span>
        {report.error && <span className="text-muted-foreground">: {report.error}</span>}
        <span className="text-muted-foreground">
          {" "}
          · {report.environmentName ? `Environment ${report.environmentName}` : "No environment"} ·{" "}
          {s.iterations} {s.iterations === 1 ? "iteration" : "iterations"}
          {report.dataFile && ` · ${report.dataFile}`}
        </span>
      </p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {stats.map((st) => (
          <div key={st.label} className="flex items-baseline gap-1.5">
            <dt className="text-xs text-muted-foreground">{st.label}</dt>
            <dd className={cn("text-sm font-medium tabular-nums", st.className)}>{st.value}</dd>
          </div>
        ))}
      </dl>
      {s.secretsLocked && (
        <p className="text-xs text-status-client">
          The secret store was locked, so some secret variables had no value. Unlock it and run again.
        </p>
      )}
    </div>
  );
}

function ResultRow({ result: r, iterations }: { result: RunResult; iterations: number }) {
  const [open, setOpen] = useState(false);
  const { passed, failed } = testCounts(r);
  const total = passed + failed;
  const hasDetails = r.tests.length > 0 || r.console.length > 0 || !!r.error || !!r.response;
  const statusClass = r.skipped
    ? "text-muted-foreground"
    : r.error
      ? "text-status-server"
      : statusTextClass(r.status);
  return (
    <li className="border-b">
      <button
        type="button"
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground",
            open && "rotate-90",
            !hasDetails && "invisible",
          )}
        />
        {iterations > 1 && (
          <span className="w-8 shrink-0 text-muted-foreground tabular-nums">#{r.iteration + 1}</span>
        )}
        <span className={cn("w-14 shrink-0 font-mono font-semibold", methodTextClass(r.method))}>
          {r.method}
        </span>
        <span className="min-w-0 flex-1 truncate">{r.name}</span>
        <span className={cn("max-w-64 shrink-0 truncate", statusClass)}>{resultStatus(r)}</span>
        <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
          {r.status ? formatDuration(r.durationMs) : ""}
        </span>
        <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
          {r.status ? formatBytes(r.size) : ""}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 text-right tabular-nums",
            total === 0 ? "text-muted-foreground" : failed > 0 ? "text-status-client" : "text-status-ok",
          )}
          aria-label={total ? `${passed} of ${total} tests passed` : "No tests"}
        >
          {total ? `${passed}/${total}` : "–"}
        </span>
      </button>
      {open && <ResultDetails result={r} />}
    </li>
  );
}

function ResultDetails({ result: r }: { result: RunResult }) {
  return (
    <div className="flex flex-col gap-3 bg-muted/20 px-10 py-2 text-xs">
      {r.error && <p className="selectable text-destructive">{r.error.message}</p>}
      {r.tests.length > 0 && (
        <section aria-label="Tests">
          <h3 className="mb-1 font-medium text-muted-foreground">Tests</h3>
          <ul className="flex flex-col gap-0.5">
            {r.tests.map((t, i) => {
              const Icon = t.skipped ? CircleMinus : t.passed ? CircleCheck : CircleX;
              const state = t.skipped ? "Skipped" : t.passed ? "Passed" : "Failed";
              return (
                <li key={i} className="flex items-start gap-1.5">
                  <Icon
                    aria-label={state}
                    className={cn(
                      "mt-0.5 size-3 shrink-0",
                      t.skipped
                        ? "text-muted-foreground"
                        : t.passed
                          ? "text-status-ok"
                          : "text-status-server",
                    )}
                  />
                  <span className="flex flex-col">
                    <span>{t.name}</span>
                    {t.error && <span className="selectable font-mono text-muted-foreground">{t.error}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {r.console.length > 0 && (
        <section aria-label="Console">
          <h3 className="mb-1 font-medium text-muted-foreground">Console</h3>
          <pre className="selectable font-mono text-[12px] break-words whitespace-pre-wrap">
            {r.console.map((c) => `${c.level}  ${c.text}`).join("\n")}
          </pre>
        </section>
      )}
      {r.response && (
        <section aria-label="Response body">
          <h3 className="mb-1 font-medium text-muted-foreground">Response body</h3>
          {r.response.omitted ? (
            <p className="text-muted-foreground">
              {r.response.omitted === "binary"
                ? "Binary body not saved."
                : "Not saved: the run's saved bodies reached their limit."}
            </p>
          ) : (
            <>
              <pre className="selectable max-h-60 overflow-auto font-mono text-[12px] break-words whitespace-pre-wrap">
                {r.response.body}
              </pre>
              {r.response.truncated && <p className="text-muted-foreground">Cut at 1 MB.</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
