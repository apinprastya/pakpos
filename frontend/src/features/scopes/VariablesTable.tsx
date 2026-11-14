import { useRef, useState } from "react";
import { toast } from "sonner";
import { Lock, LockOpen, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { parsePastedPairs } from "@/lib/pairs";
import type { ScopeRef, Variable } from "@/lib/model";
import { cn } from "@/lib/utils";
import { needsUnlock, useSecretsStore } from "@/stores/secrets";
import { SecretValueCell } from "./SecretValueCell";
import { useSecretStatus } from "./useSecretStatus";

export type RowsUpdate = (update: (rows: Variable[]) => Variable[]) => void;

export interface VariablesTableProps {
  /** Accessible name of the table, e.g. "Dev variables". */
  label: string;
  scope: ScopeRef;
  /** The rows being edited. Secret rows never carry a value. */
  rows: Variable[];
  /** The rows as saved, to know which secrets exist on disk. */
  savedRows: Variable[];
  onChange: RowsUpdate;
  /**
   * Called after a change written to disk right away (a secret made plain):
   * the scope's variables as now saved, and how to update the edited rows.
   */
  onSavedOnDisk: (saved: Variable[], update: (rows: Variable[]) => Variable[]) => void;
}

const BLANK: Variable = { key: "", value: "", enabled: true, secret: false };

export const cellInputClass =
  "h-7 w-full min-w-0 rounded-sm bg-transparent px-2 font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60 hover:bg-muted/60 focus:bg-card focus:ring-1 focus:ring-ring disabled:opacity-60";

const iconButtonClass =
  "flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

const GRID = "grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_28px_28px] items-center";

/**
 * Variables of the globals, an environment or a collection: key, value,
 * enabled, a secret toggle and delete, with an always-present blank row.
 *
 * Secret values never enter the rows. Setting, clearing and revealing one
 * goes straight to the secret store (see SecretValueCell). Making a variable
 * secret moves its value into the store; making it plain asks first, since
 * the value is then written to the workspace file.
 */
export function VariablesTable({
  label,
  scope,
  rows,
  savedRows,
  onChange,
  onSavedOnDisk,
}: VariablesTableProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const status = useSecretStatus(scope, savedRows);
  // Secrets set in this session for rows that aren't saved as secrets yet (Go's status only knows saved ones).
  const [setLocally, setSetLocally] = useState<ReadonlySet<string>>(new Set());
  const [confirmPlain, setConfirmPlain] = useState<{ index: number; key: string } | null>(null);
  const display = [...rows, BLANK];

  const savedSecret = (key: string) => savedRows.some((v) => v.secret && v.key === key);
  const markSet = (key: string, on: boolean) =>
    setSetLocally((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const isSet = (key: string): boolean | null => {
    if (setLocally.has(key)) return true;
    if (!savedSecret(key)) return false;
    if (status.locked) return null;
    return status.set.has(key);
  };

  const update = (index: number, patch: Partial<Variable>) =>
    onChange((current) =>
      index >= current.length
        ? [...current, { ...BLANK, ...patch }]
        : current.map((r, i) => {
            if (i !== index) return r;
            // Remember a secret's first key, so saving the rename keeps its stored value.
            const origin = patch.key !== undefined && r.secret ? (r.origin ?? r.key) : r.origin;
            return { ...r, ...patch, ...(origin !== undefined ? { origin } : {}) };
          }),
    );

  const remove = (index: number) => onChange((current) => current.filter((_, i) => i !== index));

  const onPasteKey = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const parsed = parsePastedPairs(e.clipboardData.getData("text"));
    if (!parsed) return;
    e.preventDefault();
    const vars = parsed.map((p) => ({ ...p, secret: false }));
    onChange((current) => [...current.slice(0, index), ...vars, ...current.slice(index + 1)]);
  };

  const focusCell = (row: number, col: "key" | "value") => {
    requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus();
    });
  };

  /** Plain → secret: the value moves into the secret store and leaves the row. */
  const makeSecret = async (index: number) => {
    const row = rows[index];
    const key = row.key.trim();
    if (!key) {
      toast.error("Name the variable before making it secret");
      return;
    }
    if (row.value) {
      if (!(await useSecretsStore.getState().ensureReady())) return;
      try {
        await api.setSecret(scope, key, row.value);
      } catch (e) {
        toast.error("Couldn't store the secret value", { description: errorMessage(e) });
        return;
      }
      markSet(key, true);
    }
    onChange((current) => current.map((r, i) => (i === index ? { ...r, secret: true, value: "" } : r)));
  };

  /** Secret → plain, after the user confirmed. */
  const makePlain = async (index: number, key: string) => {
    if (savedSecret(key)) {
      // Go writes the stored value to the file, so it never passes through the UI.
      const store = useSecretsStore.getState();
      if (store.status?.hasPassword && needsUnlock(store.status) && !(await store.ensureReady())) return;
      try {
        const saved = await api.makeVariablePlain(scope, key);
        const value = saved.find((v) => v.key === key && !v.secret)?.value ?? "";
        markSet(key, false);
        onSavedOnDisk(saved, (current) =>
          current.map((r, i) => (i === index ? { ...r, secret: false, value } : r)),
        );
        status.refresh();
      } catch (e) {
        toast.error("Couldn't make the variable plain", { description: errorMessage(e) });
      }
      return;
    }
    if (key && setLocally.has(key)) {
      try {
        await api.clearSecret(scope, key);
      } catch {
        // An unsaved key's value is unreachable anyway.
      }
      markSet(key, false);
    }
    onChange((current) => current.map((r, i) => (i === index ? { ...r, secret: false, value: "" } : r)));
  };

  return (
    <div ref={tableRef} role="table" aria-label={label} className="text-sm">
      <div role="rowgroup">
        <div role="row" className={cn(GRID, "border-b px-1 py-1 text-xs text-muted-foreground")}>
          <span role="columnheader">
            <span className="sr-only">Enabled</span>
          </span>
          <span role="columnheader" className="px-2">
            Variable
          </span>
          <span role="columnheader" className="px-2">
            Value
          </span>
          <span role="columnheader">
            <span className="sr-only">Secret</span>
          </span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
      </div>
      <div role="rowgroup">
        {display.map((row, i) => {
          const isBlank = i === rows.length;
          const n = i + 1;
          const key = row.key.trim();
          return (
            <div
              role="row"
              key={i}
              className={cn(
                GRID,
                "group border-b border-border/60 px-1 py-0.5",
                !row.enabled && !isBlank && "text-muted-foreground [&_input]:line-through",
              )}
            >
              <span role="cell" className="flex justify-center">
                {!isBlank && (
                  <Checkbox
                    aria-label={`Enable variable ${n}`}
                    checked={row.enabled}
                    onCheckedChange={(v) => update(i, { enabled: v === true })}
                  />
                )}
              </span>
              <span role="cell">
                <input
                  aria-label={`Variable ${n}`}
                  data-row={i}
                  data-col="key"
                  className={cellInputClass}
                  value={row.key}
                  placeholder={isBlank ? "Variable" : ""}
                  spellCheck={false}
                  onChange={(e) => update(i, { key: e.target.value })}
                  onPaste={(e) => onPasteKey(i, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      focusCell(i, "value");
                    }
                  }}
                />
              </span>
              <span role="cell">
                {row.secret && !isBlank ? (
                  <SecretValueCell
                    scope={scope}
                    keyName={key}
                    n={n}
                    saved={savedSecret(key)}
                    isSet={isSet(key)}
                    onStored={(on) => {
                      markSet(key, on);
                      status.refresh();
                    }}
                  />
                ) : (
                  <input
                    aria-label={`Value ${n}`}
                    data-row={i}
                    data-col="value"
                    className={cellInputClass}
                    value={row.value}
                    placeholder={isBlank ? "Value" : ""}
                    spellCheck={false}
                    onChange={(e) => update(i, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        focusCell(i + 1, "key");
                      }
                    }}
                  />
                )}
              </span>
              <span role="cell" className="flex justify-center">
                {!isBlank && (
                  <button
                    type="button"
                    aria-label={row.secret ? `Make variable ${n} plain` : `Make variable ${n} secret`}
                    aria-pressed={row.secret}
                    title={
                      row.secret ? "Secret: stored on this machine only. Click to make plain." : "Make secret"
                    }
                    onClick={() => {
                      if (row.secret) setConfirmPlain({ index: i, key });
                      else void makeSecret(i);
                    }}
                    className={cn(iconButtonClass, row.secret && "text-foreground")}
                  >
                    {row.secret ? (
                      <Lock className="size-3.5" />
                    ) : (
                      <LockOpen className="size-3.5 opacity-60" />
                    )}
                  </button>
                )}
              </span>
              <span role="cell" className="flex justify-center">
                {!isBlank && (
                  <button
                    type="button"
                    aria-label={`Delete variable ${n}`}
                    title="Delete variable"
                    onClick={() => remove(i)}
                    className={cn(
                      iconButtonClass,
                      "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {status.error && (
        <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
          Couldn&apos;t check which secrets are set: {status.error}
        </p>
      )}
      <AlertDialog open={!!confirmPlain} onOpenChange={(open) => !open && setConfirmPlain(null)}>
        {confirmPlain && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Store {confirmPlain.key ? `{{${confirmPlain.key}}}` : "this variable"} in plain text?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {savedSecret(confirmPlain.key)
                  ? "Its value is written to the workspace file now, where anyone with the workspace or its git history can read it. It's removed from the secret store."
                  : "It will be saved in the workspace file in plain text. Any value set for it on this machine is removed, so enter the value again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it secret</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void makePlain(confirmPlain.index, confirmPlain.key)}
              >
                Store in plain text
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
