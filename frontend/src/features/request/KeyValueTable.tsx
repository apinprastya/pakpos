import { useRef } from "react";
import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
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

/**
 * Editable key/value rows with an always-present blank row at the end.
 * Pasting "Key: value" lines or "a=1&b=2" into a key cell splits into rows.
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

  const update = (index: number, patch: Partial<KeyValue>) => {
    if (index >= rows.length) {
      onChange([...rows, { ...BLANK, ...patch }]);
      return;
    }
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  const onPasteKey = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const parsed = parsePastedPairs(e.clipboardData.getData("text"));
    if (!parsed) return;
    e.preventDefault();
    const before = rows.slice(0, index);
    const after = rows.slice(index + 1);
    onChange([...before, ...parsed, ...after]);
  };

  const focusCell = (row: number, col: "key" | "value") => {
    requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus();
    });
  };

  return (
    <div ref={tableRef} role="table" aria-label={label} className="text-sm">
      <div role="rowgroup">
        <div
          role="row"
          className="grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_28px] items-center border-b px-1 py-1 text-xs text-muted-foreground"
        >
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
        {display.map((row, i) => {
          const isBlank = !fixedKeys && i === rows.length;
          const n = i + 1;
          const valueInput = (
            <input
              aria-label={`${valuePlaceholder} ${n}`}
              data-row={i}
              data-col="value"
              className={inputClass}
              value={row.value}
              placeholder={isBlank ? valuePlaceholder : ""}
              spellCheck={false}
              onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  focusCell(i + 1, fixedKeys ? "value" : "key");
                }
              }}
            />
          );
          return (
            <div
              role="row"
              key={i}
              className={cn(
                "group grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_28px] items-center border-b border-border/60 px-1 py-0.5",
                !row.enabled && !isBlank && "text-muted-foreground [&_input]:line-through",
              )}
            >
              <span role="cell" className="flex justify-center">
                {!isBlank && (
                  <Checkbox
                    aria-label={`Enable row ${n}`}
                    checked={row.enabled}
                    onCheckedChange={(v) => update(i, { enabled: v === true })}
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
                  onChange={(e) => update(i, { key: e.target.value })}
                  onPaste={fixedKeys ? undefined : (e) => onPasteKey(i, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      focusCell(i, "value");
                    }
                  }}
                />
              </span>
              <span role="cell">{valueInput}</span>
              <span role="cell" className="flex justify-center">
                {!isBlank && !fixedKeys && (
                  <button
                    type="button"
                    aria-label={`Delete row ${n}`}
                    title="Delete row"
                    onClick={() => remove(i)}
                    className="flex size-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
