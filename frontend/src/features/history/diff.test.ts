import { diffLines, diffStats, toHunks, type DiffLine } from "./diff";

const show = (lines: DiffLine[] | null) =>
  lines?.map(
    (l) => `${l.op === "same" ? " " : l.op === "add" ? "+" : "-"}${l.text}:${l.a ?? ""}:${l.b ?? ""}`,
  );

describe("diffLines", () => {
  it("keeps equal texts", () => {
    expect(show(diffLines(["a", "b"], ["a", "b"]))).toEqual([" a:1:1", " b:2:2"]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("finds additions, deletions and changes with line numbers", () => {
    expect(show(diffLines(["a", "b", "c"], ["a", "x", "c", "d"]))).toEqual([
      " a:1:1",
      "-b:2:",
      "+x::2",
      " c:3:3",
      "+d::4",
    ]);
    expect(show(diffLines(["a", "b"], []))).toEqual(["-a:1:", "-b:2:"]);
    expect(show(diffLines([], ["a"]))).toEqual(["+a::1"]);
  });

  it("finds a shortest edit script", () => {
    const a = "ABCABBA".split("");
    const b = "CBABAC".split("");
    const d = diffLines(a, b)!;
    expect(diffStats(d)).toEqual({ added: 2, deleted: 3 });
    // Applying the script to a gives b.
    expect(d.filter((l) => l.op !== "del").map((l) => l.text)).toEqual(b);
    expect(d.filter((l) => l.op !== "add").map((l) => l.text)).toEqual(a);
  });

  it("gives up past maxEdits", () => {
    expect(diffLines(["a", "b", "c"], ["x", "y", "z"], 2)).toBeNull();
    expect(diffLines(["a", "b", "c"], ["x", "y", "z"], 6)).not.toBeNull();
  });

  it("handles many lines quickly", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[100] = "changed";
    b.splice(15000, 0, "inserted");
    expect(diffStats(diffLines(a, b)!)).toEqual({ added: 2, deleted: 1 });
  });
});

describe("toHunks", () => {
  it("keeps context around changes and hides the rest", () => {
    const a = Array.from({ length: 20 }, (_, i) => String(i));
    const b = [...a];
    b[10] = "x";
    const hunks = toHunks(diffLines(a, b)!, 2);
    expect(hunks.map((h) => [h.kind, h.lines.length])).toEqual([
      ["gap", 8],
      ["lines", 6],
      ["gap", 7],
    ]);
    expect(toHunks(diffLines(["a"], ["a"])!)).toEqual([
      { kind: "gap", lines: [{ op: "same", text: "a", a: 1, b: 1 }] },
    ]);
    expect(toHunks([])).toEqual([]);
  });
});
