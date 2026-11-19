import { useEffect, useMemo } from "react";
import { ChevronRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocKindIcon } from "@/features/scopes/DocKindIcon";
import { findContainer } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import { useRunnerStore } from "@/stores/runner";
import { defaultRunnerSettings, useTabSection, type Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { containerPath, runOrder, selectedIds, toRunConfig } from "./open";
import { PastRuns } from "./PastRuns";
import { RunnerConfig } from "./RunnerConfig";
import { RunResults } from "./RunResults";

const SECTIONS = ["results", "past"] as const;

/** A runner tab: configuration on the left, the run (or past runs) on the right. */
export function RunnerView({ tab }: { tab: Tab }) {
  const doc = tab.doc!;
  const targetId = doc.targetId;
  const settings = doc.runner ?? defaultRunnerSettings("collection");
  const collections = useWorkspaceStore((s) => s.collections);
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id ?? "");
  const selectedEnv = useEnvironmentsStore((s) => s.selectedId);
  const target = findContainer(collections, targetId);
  const order = useMemo(() => (target ? runOrder(target) : []), [target]);
  const path = useMemo(() => containerPath(collections, targetId), [collections, targetId]);

  const shownId = useRunnerStore((s) => s.shown[targetId] ?? null);
  const run = useRunnerStore((s) => (shownId ? s.runs[shownId] : undefined));
  const live = useRunnerStore((s) =>
    Object.values(s.runs).some((r) => !r.done && r.report.target.id === targetId),
  );
  const starting = useRunnerStore((s) => !!s.starting[targetId]);
  const allPast = useRunnerStore((s) => s.past);
  const past = useMemo(() => allPast.filter((r) => r.target.id === targetId), [allPast, targetId]);
  const [section, setSection] = useTabSection(tab, "runner", SECTIONS, "results");

  useEffect(() => {
    if (workspaceId) void useRunnerStore.getState().loadPast();
  }, [workspaceId]);

  const kind = settings.targetKind;
  const selected = selectedIds(order, settings).length;
  const busy = live || starting;
  const canRun = !!target && selected > 0 && !busy;
  const runNow = async () => {
    const id = await useRunnerStore
      .getState()
      .start(targetId, toRunConfig(targetId, order, settings, selectedEnv));
    if (id) setSection("results");
  };
  const open = (runId: string) => {
    void useRunnerStore.getState().openPast(targetId, runId);
    setSection("results");
  };

  return (
    <section aria-label={`Run ${doc.name}`} className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <DocKindIcon kind="runner" className="size-4" />
        <nav aria-label="Run target" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          {(path.length ? path : [doc.name]).map((name, i, all) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
              <span
                className={i === all.length - 1 ? "truncate font-semibold" : "truncate text-muted-foreground"}
              >
                {name}
              </span>
            </span>
          ))}
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">Runner</span>
        </nav>
        <Button size="sm" disabled={!canRun} onClick={() => void runNow()}>
          <Play /> {kind === "folder" ? "Run folder" : "Run collection"}
        </Button>
      </header>
      {!target ? (
        <p role="status" className="p-6 text-center text-sm text-muted-foreground">
          This {kind} isn&apos;t in the open workspace. Open its workspace, or close this tab.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Run settings" className="w-80 shrink-0 overflow-auto border-r">
            <RunnerConfig tabId={tab.id} settings={settings} order={order} disabled={busy} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              role="tablist"
              aria-label="Runner views"
              className="flex h-9 shrink-0 items-end gap-4 border-b px-4"
            >
              {SECTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={section === s}
                  onClick={() => setSection(s)}
                  className={
                    section === s
                      ? "border-b-2 border-primary pb-1.5 text-xs font-medium"
                      : "border-b-2 border-transparent pb-1.5 text-xs text-muted-foreground hover:text-foreground"
                  }
                >
                  {s === "results" ? "Results" : `Past runs${past.length ? ` (${past.length})` : ""}`}
                </button>
              ))}
            </div>
            {section === "past" ? (
              <PastRuns runs={past} shownId={shownId} onOpen={open} />
            ) : run ? (
              <RunResults run={run} canRunAgain={canRun} onRunAgain={() => void runNow()} />
            ) : (
              <div
                role="status"
                className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
              >
                <p className="text-sm text-muted-foreground">
                  Choose the requests and options, then select{" "}
                  {kind === "folder" ? "Run folder" : "Run collection"}.
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Requests run in the order of the sidebar, with their scripts. Past runs stay under Past
                  runs.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
