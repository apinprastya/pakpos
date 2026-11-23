import {
  describeImport,
  importTarget,
  normalizeImportResult,
  normalizeImportSummary,
  type ImportSummary,
} from "./importModel";

const summary = (s: Partial<ImportSummary> = {}): ImportSummary => ({ ...normalizeImportSummary({}), ...s });

describe("normalizeImportSummary", () => {
  it("fills missing fields and non-null lists", () => {
    expect(normalizeImportSummary(null)).toEqual({
      kind: "collection",
      name: "",
      folders: 0,
      requests: 0,
      examples: 0,
      variables: 0,
      secrets: 0,
      secretValues: false,
      replaced: [],
      warnings: [],
    });
  });

  it("keeps known kinds and warnings", () => {
    const s = normalizeImportSummary({
      kind: "globals",
      name: "G",
      replaced: ["host"],
      secretValues: true,
      warnings: [{ where: "A", message: "m" }, { where: null, message: null } as never],
    });
    expect(s.kind).toBe("globals");
    expect(s.replaced).toEqual(["host"]);
    expect(s.secretValues).toBe(true);
    expect(s.warnings).toEqual([
      { where: "A", message: "m" },
      { where: "", message: "" },
    ]);
    expect(normalizeImportSummary({ kind: "weird" }).kind).toBe("collection");
  });

  it("adds the id for a result", () => {
    expect(normalizeImportResult({ kind: "environment", id: "e1" })).toMatchObject({
      kind: "environment",
      id: "e1",
    });
    expect(normalizeImportResult(undefined).id).toBe("");
  });
});

describe("describeImport", () => {
  it.each([
    [summary({ requests: 1 }), "1 request"],
    [summary({ requests: 12, folders: 3, examples: 4 }), "12 requests in 3 folders, 4 examples"],
    [
      summary({ requests: 2, folders: 1, examples: 1, variables: 5, secrets: 2 }),
      "2 requests in 1 folder, 1 example, 5 variables (2 secret)",
    ],
    [summary({ kind: "environment", variables: 1 }), "1 variable"],
    [summary({ kind: "globals" }), "0 variables"],
  ])("%#", (s, want) => {
    expect(describeImport(s)).toBe(want);
  });
});

describe("importTarget", () => {
  it("names what the import makes", () => {
    expect(importTarget(summary({ name: "Shop" }))).toBe('New collection "Shop"');
    expect(importTarget(summary({ kind: "environment", name: "Dev" }))).toBe('New environment "Dev"');
    expect(importTarget(summary({ kind: "globals" }))).toBe("Variables merged into the globals");
  });
});
