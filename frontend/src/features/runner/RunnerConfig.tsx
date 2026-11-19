import { useEffect, useId, useState } from "react";
import { FileSpreadsheet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { methodTextClass } from "@/lib/http";
import { RUN_LIMITS, type DataPreview } from "@/lib/runModel";
import { cn } from "@/lib/utils";
import { useEnvironmentsStore } from "@/stores/environments";
import { useTabsStore, type RunnerSettings } from "@/stores/tabs";
import type { RunOrderItem } from "./open";

const NO_ENV = "none";

interface Props {
  tabId: string;
  settings: RunnerSettings;
  order: RunOrderItem[];
  disabled: boolean;
}

/** The runner tab's configuration: requests, environment, iterations, data file and options. */
export function RunnerConfig({ tabId, settings, order, disabled }: Props) {
  const update = (patch: Partial<RunnerSettings>) => useTabsStore.getState().updateRunner(tabId, patch);
  return (
    <div className="flex flex-col gap-5 p-4">
      <RequestList settings={settings} order={order} disabled={disabled} update={update} />
      <EnvironmentField settings={settings} disabled={disabled} update={update} />
      <DataFileField settings={settings} disabled={disabled} update={update} />
      <NumberField
        label="Iterations"
        value={settings.iterations}
        min={1}
        max={RUN_LIMITS.maxIterations}
        disabled={disabled || !!settings.dataFile}
        hint={settings.dataFile ? "One iteration per row of the data file." : undefined}
        onChange={(iterations) => update({ iterations })}
      />
      <NumberField
        label="Delay between requests (ms)"
        value={settings.delayMs}
        min={0}
        max={RUN_LIMITS.maxDelayMs}
        disabled={disabled}
        onChange={(delayMs) => update({ delayMs })}
      />
      <fieldset className="flex flex-col gap-2.5" disabled={disabled}>
        <legend className="mb-2 text-xs font-medium">Options</legend>
        <Option
          label="Stop at the first failure"
          hint="A request error or a failed test ends the run."
          checked={settings.stopOnFailure}
          disabled={disabled}
          onChange={(stopOnFailure) => update({ stopOnFailure })}
        />
        <Option
          label="Keep variable values set by scripts"
          hint="Values scripts set on environments, collections and globals stay after the run, as with a single send."
          checked={settings.keepVariables}
          disabled={disabled}
          onChange={(keepVariables) => update({ keepVariables })}
        />
        <Option
          label="Save responses"
          hint="Keeps response bodies with the run (secrets masked, up to 1 MB each)."
          checked={settings.saveResponses}
          disabled={disabled}
          onChange={(saveResponses) => update({ saveResponses })}
        />
        <Option
          label="Record in history"
          hint="Adds every request the run sends to History."
          checked={settings.recordHistory}
          disabled={disabled}
          onChange={(recordHistory) => update({ recordHistory })}
        />
      </fieldset>
    </div>
  );
}

type Update = (patch: Partial<RunnerSettings>) => void;

function RequestList({
  settings,
  order,
  disabled,
  update,
}: {
  settings: RunnerSettings;
  order: RunOrderItem[];
  disabled: boolean;
  update: Update;
}) {
  const excluded = new Set(settings.excludedIds);
  const selected = order.filter((o) => !excluded.has(o.request.id)).length;
  const toggle = (id: string, on: boolean) =>
    update({
      excludedIds: on ? settings.excludedIds.filter((x) => x !== id) : [...settings.excludedIds, id],
    });
  return (
    <section aria-labelledby="runner-requests" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id="runner-requests" className="text-xs font-medium">
          Requests
        </h2>
        <span className="text-xs text-muted-foreground">
          {selected} of {order.length} selected
        </span>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || selected === order.length}
          onClick={() => update({ excludedIds: [] })}
        >
          Select all
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || selected === 0}
          onClick={() => update({ excludedIds: order.map((o) => o.request.id) })}
        >
          Select none
        </Button>
      </div>
      {order.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          There are no requests here yet. Add a request in the sidebar to run it.
        </p>
      ) : (
        <ul className="flex max-h-72 flex-col overflow-auto rounded-md border">
          {order.map(({ request, folders }) => (
            <li key={request.id} className="border-b last:border-b-0">
              <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs hover:bg-muted/50">
                <Checkbox
                  checked={!excluded.has(request.id)}
                  disabled={disabled}
                  onCheckedChange={(v) => toggle(request.id, v === true)}
                  aria-label={request.name}
                />
                <span
                  className={cn("w-12 shrink-0 font-mono font-semibold", methodTextClass(request.method))}
                >
                  {request.method.toUpperCase()}
                </span>
                <span className="truncate">{request.name}</span>
                {folders.length > 0 && (
                  <span className="ml-auto shrink-0 truncate text-muted-foreground">
                    {folders.join(" / ")}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EnvironmentField({
  settings,
  disabled,
  update,
}: {
  settings: RunnerSettings;
  disabled: boolean;
  update: Update;
}) {
  const id = useId();
  const environments = useEnvironmentsStore((s) => s.environments);
  const selectedId = useEnvironmentsStore((s) => s.selectedId);
  const current = settings.environmentId ?? selectedId;
  const value = environments.some((e) => e.id === current) ? current : NO_ENV;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        Environment
      </Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(v) => update({ environmentId: v === NO_ENV ? "" : v })}
      >
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ENV}>No environment</SelectItem>
          {environments.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(String(value));
  }
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        className="h-8 w-32"
        value={disabled && hint ? "" : text}
        placeholder={disabled && hint ? "From data file" : undefined}
        disabled={disabled}
        aria-invalid={!valid}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(v) && v >= min && v <= max) onChange(v);
        }}
        onBlur={() => setText(String(value))}
      />
      <p id={`${id}-hint`} className={cn("text-xs", valid ? "text-muted-foreground" : "text-destructive")}>
        {valid ? (hint ?? `${min}–${max}`) : `Enter a whole number from ${min} to ${max}.`}
      </p>
    </div>
  );
}

function Option({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="flex flex-col">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
    </div>
  );
}

type PreviewState = { path: string; preview: DataPreview | null; error: string };

function DataFileField({
  settings,
  disabled,
  update,
}: {
  settings: RunnerSettings;
  disabled: boolean;
  update: Update;
}) {
  const path = settings.dataFile;
  const [state, setState] = useState<PreviewState>({ path: "", preview: null, error: "" });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api
      .previewData(path)
      .then((preview) => live && setState({ path, preview, error: "" }))
      .catch((e: unknown) => live && setState({ path, preview: null, error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [path]);
  const choose = async () => {
    try {
      const picked = await api.pickDataFile();
      if (picked) update({ dataFile: picked });
    } catch (e) {
      setState({ path, preview: null, error: errorMessage(e) });
    }
  };
  const current = state.path === path ? state : null;
  return (
    <section aria-labelledby="runner-data" className="flex flex-col gap-1.5">
      <h2 id="runner-data" className="text-xs font-medium">
        Data file
      </h2>
      {!path ? (
        <>
          <p className="text-xs text-muted-foreground">
            A CSV file with a header row, or a JSON array of objects. Each row is one iteration; its columns
            are <code className="font-mono">{"{{variables}}"}</code> and{" "}
            <code className="font-mono">pm.iterationData</code>.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={disabled}
            onClick={() => void choose()}
          >
            <FileSpreadsheet /> Choose data file…
          </Button>
          {state.error && !state.path && <p className="text-xs text-destructive">{state.error}</p>}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs">
            <FileSpreadsheet aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium" title={path}>
              {current?.preview?.name ?? path.split(/[\\/]/).pop()}
            </span>
            {current?.preview && (
              <span className="shrink-0 text-muted-foreground">
                {current.preview.rows} {current.preview.rows === 1 ? "row" : "rows"}
              </span>
            )}
            <span className="flex-1" />
            <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void choose()}>
              Change
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove data file"
              title="Remove data file"
              disabled={disabled}
              onClick={() => update({ dataFile: "" })}
            >
              <X />
            </Button>
          </div>
          {!current && <p className="text-xs text-muted-foreground">Reading the file…</p>}
          {current?.error && <p className="text-xs text-destructive">{current.error}</p>}
          {current?.preview && <DataTable preview={current.preview} />}
        </>
      )}
    </section>
  );
}

function DataTable({ preview }: { preview: DataPreview }) {
  return (
    <div className="max-h-40 overflow-auto rounded-md border">
      <table className="w-full text-xs" aria-label="Data file preview">
        <thead>
          <tr className="border-b bg-muted/40 text-left">
            {preview.columns.map((c) => (
              <th key={c} className="px-2 py-1 font-mono font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.sample.map((row, i) => (
            <tr key={i} className="border-b last:border-b-0">
              {row.map((v, j) => (
                <td key={j} className="max-w-40 truncate px-2 py-1 font-mono" title={v}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows > preview.sample.length && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          First {preview.sample.length} of {preview.rows} rows.
        </p>
      )}
    </div>
  );
}
