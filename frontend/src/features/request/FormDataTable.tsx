import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VarInput } from "@/components/editor/VarInput";
import type { FormField, FormFieldKind } from "@/lib/model";
import { cn } from "@/lib/utils";
import { FilePicker } from "./FilePicker";
import { varCellClass } from "./KeyValueTable";

const BLANK: FormField = { key: "", kind: "text", value: "", filePath: "", contentType: "", enabled: true };
const inputClass =
  "h-7 w-full min-w-0 rounded-sm bg-transparent px-2 font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60 hover:bg-muted/60 focus:bg-card focus:ring-1 focus:ring-ring";

interface Props {
  rows: FormField[];
  onChange: (rows: FormField[]) => void;
}

/** multipart/form-data fields; each row is text or a file. */
export function FormDataTable({ rows, onChange }: Props) {
  const display = [...rows, BLANK];
  const update = (i: number, patch: Partial<FormField>) => {
    if (i >= rows.length) onChange([...rows, { ...BLANK, ...patch }]);
    else onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  return (
    <div role="table" aria-label="Form fields" className="text-sm">
      <div
        role="row"
        className="grid grid-cols-[28px_minmax(0,2fr)_84px_minmax(0,3fr)_28px] items-center border-b px-1 py-1 text-xs text-muted-foreground"
      >
        <span role="columnheader">
          <span className="sr-only">Enabled</span>
        </span>
        <span role="columnheader" className="px-2">
          Key
        </span>
        <span role="columnheader" className="px-2">
          Type
        </span>
        <span role="columnheader" className="px-2">
          Value
        </span>
        <span role="columnheader">
          <span className="sr-only">Actions</span>
        </span>
      </div>
      {display.map((row, i) => {
        const blank = i === rows.length;
        const n = i + 1;
        return (
          <div
            role="row"
            key={i}
            className={cn(
              "group grid grid-cols-[28px_minmax(0,2fr)_84px_minmax(0,3fr)_28px] items-center border-b border-border/60 px-1 py-0.5",
              !row.enabled && !blank && "text-muted-foreground",
            )}
          >
            <span role="cell" className="flex justify-center">
              {!blank && (
                <Checkbox
                  aria-label={`Enable field ${n}`}
                  checked={row.enabled}
                  onCheckedChange={(v) => update(i, { enabled: v === true })}
                />
              )}
            </span>
            <span role="cell">
              <input
                aria-label={`Key ${n}`}
                className={inputClass}
                value={row.key}
                placeholder={blank ? "Key" : ""}
                spellCheck={false}
                onChange={(e) => update(i, { key: e.target.value })}
              />
            </span>
            <span role="cell" className="px-1">
              <Select value={row.kind} onValueChange={(v) => update(i, { kind: v as FormFieldKind })}>
                <SelectTrigger size="sm" aria-label={`Type of field ${n}`} className="h-7! w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="file">File</SelectItem>
                </SelectContent>
              </Select>
            </span>
            <span role="cell" className="min-w-0">
              {row.kind === "file" ? (
                <div className="px-1">
                  <FilePicker
                    path={row.filePath}
                    label={`field ${n}`}
                    onChange={(filePath) => update(i, { filePath })}
                  />
                </div>
              ) : (
                <VarInput
                  ariaLabel={`Value ${n}`}
                  className={varCellClass}
                  value={row.value}
                  placeholder={blank ? "Value" : ""}
                  onChange={(value) => update(i, { value })}
                />
              )}
            </span>
            <span role="cell" className="flex justify-center">
              {!blank && (
                <button
                  type="button"
                  aria-label={`Delete field ${n}`}
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
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
  );
}
