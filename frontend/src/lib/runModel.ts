/**
 * Collection runner types (Go `internal/runner` and `service.RunnerService`)
 * and their normalizers. Text in results is masked by Go ([secret:name]).
 */
import {
  normalizeConsoleEntry,
  normalizeTestResult,
  type ConsoleEntry,
  type KeyValue,
  type SendError,
  type TestResult,
} from "./model";

type Loose<T> = { [K in keyof T]?: T[K] | null };

export type RunOutcome = "running" | "passed" | "failed" | "stopped" | "canceled" | "error";
export type RunTargetKind = "collection" | "folder";

export interface RunTarget {
  id: string;
  kind: RunTargetKind;
  name: string;
  /** Names from the collection down to the target. */
  path: string[];
}

export interface RunOptions {
  stopOnFailure: boolean;
  keepVariables: boolean;
  saveResponses: boolean;
  recordHistory: boolean;
}

/** One request of the run order, as written when the run started. */
export interface RunRequestInfo {
  id: string;
  name: string;
  method: string;
  url: string;
}

/** A response kept by a run with "save responses" on (masked, capped). */
export interface SavedResponse {
  contentType: string;
  headers: KeyValue[];
  body: string;
  truncated: boolean;
  /** "binary" or "limit" when the body wasn't kept. */
  omitted: string;
}

/** One send of a run. */
export interface RunResult {
  /** 0-based. */
  iteration: number;
  /** Position in the run's requests. */
  index: number;
  requestId: string;
  name: string;
  method: string;
  startedAt: string;
  status: number;
  statusText: string;
  durationMs: number;
  size: number;
  tests: TestResult[];
  console: ConsoleEntry[];
  error: SendError | null;
  skipped: boolean;
  secretsLocked: boolean;
  response: SavedResponse | null;
}

export interface RequestStats {
  requestId: string;
  name: string;
  method: string;
  runs: number;
  errors: number;
  skipped: number;
  testsPassed: number;
  testsFailed: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface RunFailure {
  iteration: number;
  requestId: string;
  name: string;
  /** "" for a request error. */
  test: string;
  message: string;
}

export interface RunSummary {
  iterations: number;
  requests: number;
  errors: number;
  skipped: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  durationMs: number;
  avgResponseMs: number;
  perRequest: RequestStats[];
  failures: RunFailure[];
  failuresTotal: number;
  secretsLocked: boolean;
}

/** A run: configuration, results and summary (Go runner.Report). */
export interface RunReport {
  id: string;
  workspaceId: string;
  target: RunTarget;
  environmentId: string;
  environmentName: string;
  iterations: number;
  delayMs: number;
  /** The data file's name (never its path or contents). */
  dataFile: string;
  options: RunOptions;
  requests: RunRequestInfo[];
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  /** Why the runner ended the run (outcome "error"). */
  error: string;
  results: RunResult[];
  summary: RunSummary;
}

export type RunEventKind =
  "started" | "requestStarted" | "requestFinished" | "iterationFinished" | "finished";

export interface RunEvent {
  kind: RunEventKind;
  iteration: number;
  index: number;
  run: RunReport | null;
  result: RunResult | null;
  outcome: RunOutcome | "";
  error: string;
  summary: RunSummary | null;
}

/** Payload of the `runner:progress` event. */
export interface RunProgress {
  runId: string;
  workspaceId: string;
  event: RunEvent;
}

/** What to run (Go service.RunConfig). */
export interface RunConfig {
  targetId: string;
  /** Empty runs every request. */
  requestIds: string[];
  environmentId: string;
  /** 0 means one per data row (or 1). */
  iterations: number;
  delayMs: number;
  /** Path of a CSV or JSON data file ("" for none). */
  dataFile: string;
  stopOnFailure: boolean;
  keepVariables: boolean;
  saveResponses: boolean;
  recordHistory: boolean;
}

export interface RunTotals {
  requests: number;
  errors: number;
  skipped: number;
  testsPassed: number;
  testsFailed: number;
}

/** A stored run in the past runs list. */
export interface RunListItem {
  id: string;
  createdAt: string;
  target: RunTarget;
  environmentName: string;
  iterations: number;
  dataFile: string;
  outcome: RunOutcome;
  durationMs: number;
  totals: RunTotals;
}

/** A data file's name, row count, columns and first rows. */
export interface DataPreview {
  name: string;
  rows: number;
  columns: string[];
  sample: string[][];
}

export type ExportFormat = "json" | "html";

/** Limits shared with Go (runner.MaxIterations, MaxDelayMs). */
export const RUN_LIMITS = { maxIterations: 10000, maxDelayMs: 60000 } as const;

function normalizeTarget(input: Loose<RunTarget> | null | undefined): RunTarget {
  const t = input ?? {};
  return { id: t.id ?? "", kind: t.kind || "collection", name: t.name ?? "", path: t.path ?? [] };
}

function normalizeOptions(input: Loose<RunOptions> | null | undefined): RunOptions {
  const o = input ?? {};
  return {
    stopOnFailure: o.stopOnFailure ?? false,
    keepVariables: o.keepVariables ?? false,
    saveResponses: o.saveResponses ?? false,
    recordHistory: o.recordHistory ?? false,
  };
}

function normalizeSaved(input: Loose<SavedResponse> | null | undefined): SavedResponse | null {
  if (!input) return null;
  return {
    contentType: input.contentType ?? "",
    headers: (input.headers ?? []).map((h) => ({
      key: h.key ?? "",
      value: h.value ?? "",
      enabled: h.enabled ?? true,
    })),
    body: input.body ?? "",
    truncated: input.truncated ?? false,
    omitted: input.omitted ?? "",
  };
}

export function normalizeRunResult(input: unknown): RunResult {
  const r = (input ?? {}) as Loose<RunResult>;
  return {
    iteration: r.iteration ?? 0,
    index: r.index ?? 0,
    requestId: r.requestId ?? "",
    name: r.name ?? "",
    method: r.method || "GET",
    startedAt: r.startedAt ?? "",
    status: r.status ?? 0,
    statusText: r.statusText ?? "",
    durationMs: r.durationMs ?? 0,
    size: r.size ?? 0,
    tests: (r.tests ?? []).map(normalizeTestResult),
    console: (r.console ?? []).map(normalizeConsoleEntry),
    error: r.error ? { kind: r.error.kind, message: r.error.message } : null,
    skipped: r.skipped ?? false,
    secretsLocked: r.secretsLocked ?? false,
    response: normalizeSaved(r.response),
  };
}

export function emptyRunSummary(): RunSummary {
  return {
    iterations: 0,
    requests: 0,
    errors: 0,
    skipped: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    durationMs: 0,
    avgResponseMs: 0,
    perRequest: [],
    failures: [],
    failuresTotal: 0,
    secretsLocked: false,
  };
}

export function normalizeRunSummary(input: unknown): RunSummary {
  const s = (input ?? {}) as Loose<RunSummary>;
  const base = emptyRunSummary();
  return {
    ...base,
    ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== undefined)),
    perRequest: (s.perRequest ?? []) as RequestStats[],
    failures: (s.failures ?? []) as RunFailure[],
  } as RunSummary;
}

export function normalizeRunReport(input: unknown): RunReport {
  const r = (input ?? {}) as Loose<RunReport>;
  return {
    id: r.id ?? "",
    workspaceId: r.workspaceId ?? "",
    target: normalizeTarget(r.target),
    environmentId: r.environmentId ?? "",
    environmentName: r.environmentName ?? "",
    iterations: r.iterations ?? 1,
    delayMs: r.delayMs ?? 0,
    dataFile: r.dataFile ?? "",
    options: normalizeOptions(r.options),
    requests: (r.requests ?? []).map((q) => ({
      id: q.id ?? "",
      name: q.name ?? "",
      method: q.method || "GET",
      url: q.url ?? "",
    })),
    startedAt: r.startedAt ?? "",
    finishedAt: r.finishedAt ?? "",
    outcome: r.outcome || "running",
    error: r.error ?? "",
    results: (r.results ?? []).map(normalizeRunResult),
    summary: normalizeRunSummary(r.summary),
  };
}

export function normalizeRunEvent(input: unknown): RunEvent {
  const e = (input ?? {}) as Loose<RunEvent>;
  return {
    kind: e.kind || "started",
    iteration: e.iteration ?? 0,
    index: e.index ?? 0,
    run: e.run ? normalizeRunReport(e.run) : null,
    result: e.result ? normalizeRunResult(e.result) : null,
    outcome: e.outcome ?? "",
    error: e.error ?? "",
    summary: e.summary ? normalizeRunSummary(e.summary) : null,
  };
}

export function normalizeRunListItem(input: unknown): RunListItem {
  const r = (input ?? {}) as Loose<RunListItem>;
  const t = (r.totals ?? {}) as Loose<RunTotals>;
  return {
    id: r.id ?? "",
    createdAt: r.createdAt ?? "",
    target: normalizeTarget(r.target),
    environmentName: r.environmentName ?? "",
    iterations: r.iterations ?? 1,
    dataFile: r.dataFile ?? "",
    outcome: r.outcome || "passed",
    durationMs: r.durationMs ?? 0,
    totals: {
      requests: t.requests ?? 0,
      errors: t.errors ?? 0,
      skipped: t.skipped ?? 0,
      testsPassed: t.testsPassed ?? 0,
      testsFailed: t.testsFailed ?? 0,
    },
  };
}

export function normalizeDataPreview(input: unknown): DataPreview {
  const p = (input ?? {}) as Loose<DataPreview>;
  return { name: p.name ?? "", rows: p.rows ?? 0, columns: p.columns ?? [], sample: p.sample ?? [] };
}

/** Passed, failed and skipped tests of a result. */
export function testCounts(r: Pick<RunResult, "tests">): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of r.tests) {
    if (t.skipped) skipped++;
    else if (t.passed) passed++;
    else failed++;
  }
  return { passed, failed, skipped };
}

/** A request error or a failed test. */
export function resultFailed(r: RunResult): boolean {
  return r.error !== null || testCounts(r).failed > 0;
}
