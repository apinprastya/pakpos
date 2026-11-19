import {
  normalizeDataPreview,
  normalizeRunEvent,
  normalizeRunListItem,
  normalizeRunReport,
  normalizeRunResult,
  normalizeRunSummary,
  resultFailed,
  testCounts,
} from "./runModel";
import { makeRunResult, makeTestResult } from "@/test/fixtures";

describe("run model", () => {
  it("fills everything Go may leave null", () => {
    const r = normalizeRunReport({
      target: null,
      options: null,
      requests: [{ id: "r1", method: "" }],
      results: null,
    });
    expect(r.target).toEqual({ id: "", kind: "collection", name: "", path: [] });
    expect(r.options.keepVariables).toBe(false);
    expect(r.requests[0]).toEqual({ id: "r1", name: "", method: "GET", url: "" });
    expect(r.results).toEqual([]);
    expect(r.outcome).toBe("running");
    expect(r.summary.perRequest).toEqual([]);
    expect(normalizeRunReport(null).iterations).toBe(1);

    const res = normalizeRunResult({
      tests: null,
      console: null,
      error: { kind: "dns", message: "x" },
      response: { headers: [{ key: "A", value: null }], body: null },
    });
    expect(res.method).toBe("GET");
    expect(res.error).toEqual({ kind: "dns", message: "x" });
    expect(res.response).toEqual({
      contentType: "",
      headers: [{ key: "A", value: "", enabled: true }],
      body: "",
      truncated: false,
      omitted: "",
    });
    expect(normalizeRunResult(undefined).response).toBeNull();

    const s = normalizeRunSummary({ requests: 4, errors: null, failures: null });
    expect(s.requests).toBe(4);
    expect(s.errors).toBe(0);
    expect(s.failures).toEqual([]);

    const e = normalizeRunEvent({ kind: "finished", summary: { requests: 1 }, run: { id: "x" }, result: {} });
    expect(e.summary?.requests).toBe(1);
    expect(e.run?.id).toBe("x");
    expect(e.result?.name).toBe("");
    expect(normalizeRunEvent(null)).toMatchObject({
      kind: "started",
      run: null,
      result: null,
      summary: null,
    });

    const item = normalizeRunListItem({ id: "a", totals: null, outcome: "" });
    expect(item.totals.requests).toBe(0);
    expect(item.outcome).toBe("passed");
    expect(normalizeRunListItem(null).iterations).toBe(1);

    expect(normalizeDataPreview({ name: "d.csv", columns: null })).toEqual({
      name: "d.csv",
      rows: 0,
      columns: [],
      sample: [],
    });
  });

  it("counts tests and failures", () => {
    const r = makeRunResult("a", {
      tests: [
        makeTestResult("ok"),
        makeTestResult("bad", { passed: false, error: "no" }),
        makeTestResult("later", { passed: false, skipped: true }),
      ],
    });
    expect(testCounts(r)).toEqual({ passed: 1, failed: 1, skipped: 1 });
    expect(resultFailed(r)).toBe(true);
    expect(resultFailed(makeRunResult("b"))).toBe(false);
    expect(resultFailed(makeRunResult("c", { error: { kind: "dns", message: "" } }))).toBe(true);
  });
});
