import { Profiler, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { VarScopeContext } from "@/components/editor/varScopeContext";
import { makePreviewVar } from "@/test/fixtures";
import { focusField } from "@/test/editor";
import type { KeyValue } from "@/lib/model";
import { makeScope } from "@/lib/variables";
import { KeyValueTable } from "./KeyValueTable";

// Counts static cell renders (every value cell not being edited renders one VarText).
const counter = vi.hoisted(() => ({ varText: 0 }));
vi.mock("@/components/editor/VarText", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/editor/VarText")>();
  const Original = mod.VarText as unknown as { type: (p: unknown) => unknown };
  const { memo } = await import("react");
  return {
    ...mod,
    VarText: memo((p: Parameters<typeof Original.type>[0]) => {
      counter.varText++;
      return Original.type(p) as React.ReactNode;
    }),
  };
});

// The structural checks (one CodeMirror view, no other row re-rendering) don't
// depend on the table size, so the regular suite uses a small table. Timing a
// 200-row table is an opt-in bench, because wall-clock numbers under a loaded
// test runner (coverage, parallel workers) mean nothing and used to hit the
// 5 s test timeout: `PAKPOS_BENCH=1 npx vitest run KeyValueTable.perf`.
const BENCH = Boolean(import.meta.env.PAKPOS_BENCH);
const scope = makeScope([makePreviewVar("token", "t"), makePreviewVar("host", "h")], null, true);
const makeRows = (n: number): KeyValue[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `X-Header-${i}`,
    value: i % 2 ? `Bearer {{token}}-${i}` : `{{host}}/{{missing}}/${i}`,
    enabled: true,
  }));

function Host({ initial, onCommit }: { initial: KeyValue[]; onCommit: (ms: number) => void }) {
  const [rows, setRows] = useState(initial);
  return (
    <VarScopeContext.Provider value={scope}>
      <Profiler id="headers" onRender={(_id, _phase, actual) => onCommit(actual)}>
        <KeyValueTable label="Headers" keyPlaceholder="Header" rows={rows} onChange={setRows} />
      </Profiler>
    </VarScopeContext.Provider>
  );
}

const editors = () => document.querySelectorAll(".cm-editor").length;
const TEXT = "-abcdefghijklmnopqrs";

/** Renders `rows` header rows, edits one cell and checks the table stays cheap. */
async function exercise(rows: number) {
  counter.varText = 0;
  const commits: number[] = [];
  const t0 = performance.now();
  render(<Host initial={makeRows(rows)} onCommit={(ms) => commits.push(ms)} />);
  const mountMs = performance.now() - t0;

  expect(screen.getAllByRole("row")).toHaveLength(rows + 2); // header + rows + blank
  expect(editors()).toBe(0);
  expect(counter.varText).toBe(rows);

  // Focus a cell in the middle: one editor for the whole table.
  const middle = Math.floor(rows / 2);
  const view = focusField(`Value ${middle}`);
  expect(editors()).toBe(1);

  counter.varText = 0;
  commits.length = 0;
  const t1 = performance.now();
  for (const ch of TEXT) {
    const end = view.state.doc.length;
    act(() => view.dispatch({ changes: { from: end, insert: ch }, userEvent: "input.type" }));
  }
  const typingMs = performance.now() - t1;
  const reRendered = counter.varText;

  expect(view.state.doc.toString()).toBe(`Bearer {{token}}-${middle - 1}${TEXT}`);
  // No other row re-rendered its static text while typing.
  expect(reRendered).toBe(0);
  expect(editors()).toBe(1);

  // Moving to another cell swaps the editor: one again once the old cell's blur lands.
  act(() => screen.getByRole("textbox", { name: "Value 5" }).focus());
  await waitFor(() => expect(editors()).toBe(1));
  expect(screen.getByRole("textbox", { name: `Value ${middle}` })).toHaveAttribute("data-slot", "var-input");

  const perKey = commits.reduce((a, b) => a + b, 0) / Math.max(commits.length, 1);
  return { mountMs, typingMs, perKey, commits: commits.length, reRendered };
}

describe("a headers table with variables", () => {
  it("has at most one editor and re-renders only the edited row while typing", async () => {
    await exercise(40);
  });
});

describe.runIf(BENCH)("bench: a 200-row headers table", () => {
  it("measures mount, typing and commit times", { timeout: 60_000 }, async () => {
    const m = await exercise(200);
    console.info(
      `[perf] 200 rows: mount ${m.mountMs.toFixed(1)} ms; typing ${TEXT.length} chars ${m.typingMs.toFixed(1)} ms ` +
        `(${(m.typingMs / TEXT.length).toFixed(2)} ms/char); React commit ${m.perKey.toFixed(2)} ms avg over ${m.commits} commits; ` +
        `static cells re-rendered while typing: ${m.reRendered}`,
    );
  });
});
