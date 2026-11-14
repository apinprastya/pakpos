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

const ROWS = 200;
const scope = makeScope([makePreviewVar("token", "t"), makePreviewVar("host", "h")], null, true);
const initial: KeyValue[] = Array.from({ length: ROWS }, (_, i) => ({
  key: `X-Header-${i}`,
  value: i % 2 ? `Bearer {{token}}-${i}` : `{{host}}/{{missing}}/${i}`,
  enabled: true,
}));

function Host({ onCommit }: { onCommit: (ms: number) => void }) {
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

describe("a 200-row headers table", () => {
  it("has at most one editor and re-renders only the edited row while typing", async () => {
    const commits: number[] = [];
    const t0 = performance.now();
    render(<Host onCommit={(ms) => commits.push(ms)} />);
    const mountMs = performance.now() - t0;

    expect(screen.getAllByRole("row")).toHaveLength(ROWS + 2); // header + rows + blank
    expect(editors()).toBe(0);
    expect(counter.varText).toBe(ROWS);

    // Focus a cell in the middle: one editor for the whole table.
    const view = focusField("Value 100");
    expect(editors()).toBe(1);

    counter.varText = 0;
    commits.length = 0;
    const text = "-abcdefghijklmnopqrs";
    const t1 = performance.now();
    for (const ch of text) {
      const end = view.state.doc.length;
      act(() => view.dispatch({ changes: { from: end, insert: ch }, userEvent: "input.type" }));
    }
    const typingMs = performance.now() - t1;
    const reRendered = counter.varText;

    expect(view.state.doc.toString()).toBe(`Bearer {{token}}-99${text}`);
    // No other row re-rendered its static text while typing.
    expect(reRendered).toBe(0);
    expect(editors()).toBe(1);

    // Moving to another cell swaps the editor: one again once the old cell's blur lands.
    act(() => screen.getByRole("textbox", { name: "Value 5" }).focus());
    await waitFor(() => expect(editors()).toBe(1));
    expect(screen.getByRole("textbox", { name: "Value 100" })).toHaveAttribute("data-slot", "var-input");

    const perKey = commits.reduce((a, b) => a + b, 0) / Math.max(commits.length, 1);
    console.info(
      `[perf] ${ROWS} rows: mount ${mountMs.toFixed(1)} ms; typing ${text.length} chars ${typingMs.toFixed(1)} ms ` +
        `(${(typingMs / text.length).toFixed(2)} ms/char); React commit ${perKey.toFixed(2)} ms avg over ${commits.length} commits; ` +
        `static cells re-rendered while typing: ${reRendered}`,
    );
  });
});
