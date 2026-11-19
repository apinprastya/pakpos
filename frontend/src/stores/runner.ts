import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { ConsoleEntry } from "@/lib/model";
import {
  emptyRunSummary,
  type ExportFormat,
  type RunConfig,
  type RunListItem,
  type RunProgress,
  type RunReport,
  type RunResult,
} from "@/lib/runModel";
import { useConsoleStore } from "./console";

/** A run the UI knows about: live (from `runner:progress`) or loaded from Go. */
export interface RunState {
  report: RunReport;
  /** The request being sent, while live. */
  current: { iteration: number; index: number } | null;
  done: boolean;
}

/**
 * Collection runs. Runs live in memory only (never localStorage): a runner
 * tab keeps its configuration, and past runs are reloaded from Go
 * (`RunnerService.List/Get`).
 */
interface RunnerState {
  runs: Record<string, RunState>;
  /** The run each target's runner tab shows (by collection or folder id). */
  shown: Record<string, string | null>;
  /** Targets whose run is being started. */
  starting: Record<string, boolean>;
  past: RunListItem[];
  pastStatus: "idle" | "loading" | "ready" | "error";
  pastError: string;

  start: (targetId: string, config: RunConfig) => Promise<string | null>;
  cancel: (runId: string) => Promise<void>;
  /** Shows a run in the target's tab (null: none). */
  show: (targetId: string, runId: string | null) => void;
  /** Loads a stored run and shows it. */
  openPast: (targetId: string, runId: string) => Promise<void>;
  loadPast: () => Promise<void>;
  removePast: (runId: string) => Promise<void>;
  exportRun: (runId: string, format: ExportFormat) => Promise<void>;
  handle: (p: RunProgress) => void;
}

/** "Skipped", the error message, or "200 OK". */
export function resultStatus(r: RunResult): string {
  if (r.skipped) return "Skipped";
  if (r.error) return r.error.message;
  return `${r.status} ${r.statusText}`.trim();
}

/** A pre-request script error as a console line, like a single send's. */
function consoleLines(r: RunResult): ConsoleEntry[] {
  if (r.error?.kind !== "script") return r.console;
  const source = { kind: "request" as const, id: r.requestId, name: r.name, event: "prerequest" as const };
  return [...r.console, { level: "error", text: r.error.message, source }];
}

/** A placeholder until the run's "started" event arrives. */
function pending(id: string, config: RunConfig): RunReport {
  return {
    id,
    workspaceId: "",
    target: { id: config.targetId, kind: "collection", name: "", path: [] },
    environmentId: config.environmentId,
    environmentName: "",
    iterations: config.iterations || 1,
    delayMs: config.delayMs,
    dataFile: "",
    options: {
      stopOnFailure: config.stopOnFailure,
      keepVariables: config.keepVariables,
      saveResponses: config.saveResponses,
      recordHistory: config.recordHistory,
    },
    requests: [],
    startedAt: new Date().toISOString(),
    finishedAt: "",
    outcome: "running",
    error: "",
    results: [],
    summary: emptyRunSummary(),
  };
}

let unlisten: (() => void) | null = null;

/** Subscribes to `runner:progress` once (on the first run started). */
function ensureListening() {
  if (!unlisten) unlisten = api.onRunnerProgress((p) => useRunnerStore.getState().handle(p));
}

/** Drops the subscription (tests reset the store between cases). */
export function stopListening(): void {
  unlisten?.();
  unlisten = null;
}

export const useRunnerStore = create<RunnerState>()((set, get) => ({
  runs: {},
  shown: {},
  starting: {},
  past: [],
  pastStatus: "idle",
  pastError: "",

  start: async (targetId, config) => {
    ensureListening();
    set((s) => ({ starting: { ...s.starting, [targetId]: true } }));
    try {
      const id = await api.startRun(config);
      set((s) => ({
        shown: { ...s.shown, [targetId]: id },
        runs: s.runs[id]
          ? s.runs
          : { ...s.runs, [id]: { report: pending(id, config), current: null, done: false } },
      }));
      return id;
    } catch (e) {
      toast.error("Couldn't start the run", { description: errorMessage(e) });
      return null;
    } finally {
      set((s) => ({ starting: { ...s.starting, [targetId]: false } }));
    }
  },

  cancel: async (runId) => {
    try {
      await api.cancelRun(runId);
    } catch (e) {
      toast.error("Couldn't cancel the run", { description: errorMessage(e) });
    }
  },

  show: (targetId, runId) => set((s) => ({ shown: { ...s.shown, [targetId]: runId } })),

  openPast: async (targetId, runId) => {
    if (get().runs[runId]) {
      get().show(targetId, runId);
      return;
    }
    try {
      const report = await api.getRun(runId);
      set((s) => ({
        runs: { ...s.runs, [runId]: { report, current: null, done: true } },
        shown: { ...s.shown, [targetId]: runId },
      }));
    } catch (e) {
      toast.error("Couldn't open the run", { description: errorMessage(e) });
    }
  },

  loadPast: async () => {
    set({ pastStatus: "loading" });
    try {
      set({ past: await api.listRuns(), pastStatus: "ready", pastError: "" });
    } catch (e) {
      set({ pastStatus: "error", pastError: errorMessage(e) });
    }
  },

  removePast: async (runId) => {
    try {
      await api.deleteRun(runId);
    } catch (e) {
      toast.error("Couldn't delete the run", { description: errorMessage(e) });
      return;
    }
    set((s) => {
      const runs = { ...s.runs };
      delete runs[runId];
      const shown = Object.fromEntries(Object.entries(s.shown).map(([k, v]) => [k, v === runId ? null : v]));
      return { runs, shown, past: s.past.filter((r) => r.id !== runId) };
    });
  },

  exportRun: async (runId, format) => {
    try {
      const path = await api.exportRun(runId, format);
      if (path) toast.success("Report saved", { description: path });
    } catch (e) {
      toast.error("Couldn't export the report", { description: errorMessage(e) });
    }
  },

  handle: ({ runId, event }) => {
    const run = get().runs[runId];
    switch (event.kind) {
      case "started": {
        if (!event.run) return;
        const report = { ...event.run, id: runId, results: run?.report.results ?? [] };
        set((s) => ({
          runs: { ...s.runs, [runId]: { report, current: run?.current ?? null, done: false } },
          shown: { ...s.shown, [report.target.id]: runId },
        }));
        return;
      }
      case "requestStarted":
        if (!run) return;
        set((s) => ({
          runs: {
            ...s.runs,
            [runId]: { ...run, current: { iteration: event.iteration, index: event.index } },
          },
        }));
        return;
      case "requestFinished": {
        const result = event.result;
        if (!run || !result) return;
        set((s) => ({
          runs: {
            ...s.runs,
            [runId]: { ...run, report: { ...run.report, results: [...run.report.results, result] } },
          },
        }));
        useConsoleStore.getState().addRunSend(
          `${runId}:${run.report.results.length}`,
          {
            method: result.method,
            name: result.name,
            status: resultStatus(result),
            startedAt: Date.parse(result.startedAt) || Date.now(),
            context: `Run ${run.report.target.name} · Iteration ${result.iteration + 1}`,
          },
          consoleLines(result),
        );
        return;
      }
      case "finished": {
        if (!run) return;
        const report: RunReport = {
          ...run.report,
          outcome: event.outcome || "passed",
          error: event.error,
          summary: event.summary ?? run.report.summary,
          finishedAt: new Date().toISOString(),
        };
        set((s) => ({ runs: { ...s.runs, [runId]: { report, current: null, done: true } } }));
        void get().loadPast();
        return;
      }
      default:
        return;
    }
  },
}));

/** Resets the store (tests). */
export function resetRunnerStore(): void {
  stopListening();
  useRunnerStore.setState({
    runs: {},
    shown: {},
    starting: {},
    past: [],
    pastStatus: "idle",
    pastError: "",
  });
}
