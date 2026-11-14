import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { VarInput } from "@/components/editor/VarInput";
import { parsePastedPairs } from "@/lib/pairs";
import type { KeyValue } from "@/lib/model";
import { cn } from "@/lib/utils";

export interface KeyValueTableProps {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  /** Accessible name of the table, e.g. "Query parameters". */
  label: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Keys are fixed (e.g. path params): no adding, deleting or key editing. */
  fixedKeys?: boolean;
}

const BLANK: KeyValue = { key: "", value: "", enabled: true };

const inputClass =
  "h-7 w-full min-w-0 rounded-sm bg-transparent px-2 font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60 hover:bg-muted/60 focus:bg-card focus:ring-1 focus:ring-ring disabled:opacity-60";

/** Value cells: static text with highlighted {{variables}}, an editor while focused. */
export const varCellClass = "h-7 w-full min-w-0 rounded-sm px-2 text-[12.5px]";

const GRID = "grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_28px] items-center";

interface RowHandlers {
  update: (index: number, patch: Partial<KeyValue>) => void;
  remove: (index: number) => void;
  pasteKey: (index: number, e: React.ClipboardEvent<HTMLInputElement>) => void;
  focusCell: (row: number, col: "key" | "value") => void;
}

/**
 * Editable key/value rows with an always-present blank row at the end.
 * Pasting "Key: value" lines or "a=1&b=2" into a key cell splits into rows.
 *
 * Rows are memoized and the handlers are stable, so typing in one row
 * re-renders only that row, which keeps large tables responsive.
 */
export function KeyValueTable({
  rows,
  onChange,
  label,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  fixedKeys = false,
}: KeyValueTableProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const display = fixedKeys ? rows : [...rows, BLANK];
  const latest = useRef({ rows, onChange });
  useLayoutEffect(() => {
    latest.current = { rows, onChange };
  });

  const update = useCallback((index: number, patch: Partial<KeyValue>) => {
    const { rows, onChange } = latest.current;
    if (index >= rows.length) {
      onChange([...rows, { ...BLANK, ...patch }]);
      return;
    }
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const remove = useCallback((index: number) => {
    const { rows, onChange } = latest.current;
    onChange(rows.filter((_, i) => i !== index));
  }, []);

  const pasteKey = useCallback((index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const parsed = parsePastedPairs(e.clipboardData.getData("text"));
    if (!parsed) return;
    e.preventDefault();
    const { rows, onChange } = latest.current;
    onChange([...rows.slice(0, index), ...parsed, ...rows.slice(index + 1)]);
  }, []);

  const focusCell = useCallback((row: number, col: "key" | "value") => {
    requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus();
    });
  }, []);

  const handlers = useMemo<RowHandlers>(
    () => ({ update, remove, pasteKey, focusCell }),
    [update, remove, pasteKey, focusCell],
  );

  return (
    <div ref={tableRef} role="table" aria-label={label} className="text-sm">
      <div role="rowgroup">
        <div role="row" className={cn(GRID, "border-b px-1 py-1 text-xs text-muted-foreground")}>
          <span role="columnheader">
            <span className="sr-only">Enabled</span>
          </span>
          <span role="columnheader" className="px-2">
            {keyPlaceholder}
          </span>
          <span role="columnheader" className="px-2">
            {valuePlaceholder}
          </span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
      </div>
      <div role="rowgroup">
        {display.map((row, i) => (
          <Row
            key={i}
            row={row}
            index={i}
            isBlank={!fixedKeys && i === rows.length}
            fixedKeys={fixedKeys}
            keyPlaceholder={keyPlaceholder}
            valuePlaceholder={valuePlaceholder}
            handlers={handlers}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  row: KeyValue;
  index: number;
  isBlank: boolean;
  fixedKeys: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  handlers: RowHandlers;
}

const Row = memo(function Row({
  row,
  index: i,
  isBlank,
  fixedKeys,
  keyPlaceholder,
  valuePlaceholder,
  handlers,
}: RowProps) {
  const n = i + 1;
  const struck = !row.enabled && !isBlank;
  return (
    <div
      role="row"
      className={cn(
        GRID,
        "group border-b border-border/60 px-1 py-0.5",
        struck && "text-muted-foreground [&_input]:line-through",
      )}
    >
      <span role="cell" className="flex justify-center">
        {!isBlank && (
          <Checkbox
            aria-label={`Enable row ${n}`}
            checked={row.enabled}
            onCheckedChange={(v) => handlers.update(i, { enabled: v === true })}
          />
        )}
      </span>
      <span role="cell">
        <input
          aria-label={`${keyPlaceholder} ${n}`}
          data-row={i}
          data-col="key"
          className={inputClass}
          value={row.key}
          placeholder={isBlank ? keyPlaceholder : ""}
          readOnly={fixedKeys}
          spellCheck={false}
          onChange={(e) => handlers.update(i, { key: e.target.value })}
          onPaste={fixedKeys ? undefined : (e) => handlers.pasteKey(i, e)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handlers.focusCell(i, "value");
            }
          }}
        />
      </span>
      <span role="cell" className="min-w-0">
        <VarInput
          ariaLabel={`${valuePlaceholder} ${n}`}
          dataRow={i}
          dataCol="value"
          className={cn(varCellClass, struck && "line-through")}
          value={row.value}
          placeholder={isBlank ? valuePlaceholder : ""}
          onChange={(value) => handlers.update(i, { value })}
          onEnter={() => handlers.focusCell(i + 1, fixedKeys ? "value" : "key")}
        />
      </span>
      <span role="cell" className="flex justify-center">
        {!isBlank && !fixedKeys && (
          <button
            type="button"
            aria-label={`Delete row ${n}`}
            title="Delete row"
            onClick={() => handlers.remove(i)}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
});
