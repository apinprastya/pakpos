import { useState } from "react";
import { CircleCheck, CircleMinus, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openRequestScripts, openScriptSource } from "@/features/scripts/open";
import type { TestResult } from "@/lib/model";
import { cn } from "@/lib/utils";
import { testCounts } from "./tests";

export type TestFilter = "all" | "passed" | "failed";

/** The response's Tests tab label: "3/4", green when all passed, amber when any failed. */
export function TestsCount({ tests }: { tests: TestResult[] }) {
  const { passed, total, failed } = testCounts(tests);
  if (total === 0) return null;
  return (
    <span
      className={cn(
        "rounded-sm bg-muted px-1 text-[10px] tabular-nums",
        failed > 0 ? "text-status-client" : "text-status-ok",
      )}
    >
      {passed}/{total}
    </span>
  );
}

const FILTERS: { id: TestFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
];

function where(t: TestResult): string {
  const ev = t.source.event === "prerequest" ? "pre-request" : "test";
  return t.source.kind === "request" ? `${ev} script` : `${ev} script of ${t.source.kind} ${t.source.name}`;
}

/** The pm.test results of the last send, with a filter. */
export function TestsView({ tabId, tests }: { tabId: string; tests: TestResult[] }) {
  const [filter, setFilter] = useState<TestFilter>("all");
  if (tests.length === 0) {
    return (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground">No tests ran for this request.</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Add tests in the request&apos;s Scripts tab, for example{" "}
          <code className="font-mono">pm.response.to.have.status(200)</code> inside{" "}
          <code className="font-mono">pm.test</code>.
        </p>
        <Button variant="outline" size="sm" onClick={() => openRequestScripts(tabId, "test")}>
          Open tests
        </Button>
      </div>
    );
  }
  const shown = tests.filter((t) =>
    filter === "all" ? true : filter === "passed" ? t.passed : !t.passed && !t.skipped,
  );
  const { passed, failed } = testCounts(tests);
  const counts: Record<TestFilter, number> = { all: tests.length, passed, failed };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="group"
        aria-label="Show tests"
        className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5"
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-sm px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              filter === f.id && "bg-muted text-foreground",
            )}
          >
            {f.label} <span className="tabular-nums">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {filter === "failed" ? "No test failed." : "No test passed."}
        </p>
      ) : (
        <ul aria-label="Test results" className="min-h-0 flex-1 overflow-auto">
          {shown.map((t, i) => (
            <TestRow key={i} tabId={tabId} test={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TestRow({ tabId, test }: { tabId: string; test: TestResult }) {
  const state = test.skipped ? "Skipped" : test.passed ? "Passed" : "Failed";
  const Icon = test.skipped ? CircleMinus : test.passed ? CircleCheck : CircleX;
  return (
    <li className="flex items-start gap-2 border-b border-border/60 px-3 py-1.5 text-sm">
      <Icon
        aria-label={state}
        className={cn(
          "mt-0.5 size-4 shrink-0",
          test.skipped ? "text-muted-foreground" : test.passed ? "text-status-ok" : "text-status-client",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="selectable break-words">{test.name || "(unnamed test)"}</p>
        {!test.passed && test.error && (
          <p className="selectable font-mono text-xs break-words text-muted-foreground">{test.error}</p>
        )}
      </div>
      <Button
        variant="link"
        size="xs"
        className="h-auto shrink-0 p-0 text-muted-foreground"
        title={`Open the ${where(test)}`}
        onClick={() => openScriptSource(tabId, test.source)}
      >
        {where(test)}
      </Button>
    </li>
  );
}
