import { useEffect, useMemo } from "react";
import { Copy, Fingerprint, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { cn } from "@/lib/utils";
import type { ToolProps } from "../registry";
import { formatId, generateIds, inspectId, parseCount, type IdKind, type Inspection } from "./ids";
import type { IdsState } from "./state";

const KINDS: { id: IdKind; label: string; hint: string }[] = [
  { id: "uuid4", label: "UUID v4", hint: "Random" },
  { id: "uuid7", label: "UUID v7", hint: "Starts with the time, so IDs sort by when they were made" },
  { id: "ulid", label: "ULID", hint: "26 characters, time first, sorts by when it was made" },
];

const CASES: { id: "lower" | "upper"; label: string }[] = [
  { id: "lower", label: "Lower case" },
  { id: "upper", label: "Upper case" },
];

function Segmented<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5">
      {items.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          title={m.hint}
          onClick={() => onChange(m.id)}
          className={cn(
            "h-6 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === m.id && "bg-accent text-accent-foreground hover:bg-accent",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** A new batch for the state's kind and count (the state unchanged when the count isn't valid). */
function regenerate(s: IdsState): IdsState {
  const count = parseCount(s.count);
  if (!count.ok) return s;
  return { ...s, generated: { kind: s.kind, ids: generateIds({ kind: s.kind, count: count.count }) } };
}

const nf = new Intl.NumberFormat();

/** The ID generator: UUID v4, UUID v7 and ULID batches, plus an inspector for pasted IDs. */
export function IdsTool({ tabId, state, update }: ToolProps<IdsState>) {
  const count = parseCount(state.count);
  const isUuid = state.kind !== "ulid";

  // A new or reopened tab starts with a fresh batch.
  useEffect(() => {
    if (!state.generated) update(regenerate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ids = state.generated;
  const output = useMemo(
    () =>
      ids
        ? ids.ids
            .map((id) => formatId(id, ids.kind, { upper: state.upper, hyphens: state.hyphens }))
            .join("\n")
        : "",
    [ids, state.upper, state.hyphens],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      toast.success(ids && ids.ids.length > 1 ? `${nf.format(ids.ids.length)} IDs copied` : "ID copied");
    } catch {
      toast.error("Couldn't copy the IDs", { description: "The clipboard isn't available." });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Fingerprint aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">ID generator</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <Segmented
          label="Kind"
          items={KINDS}
          value={state.kind}
          onChange={(kind) => update((s) => regenerate({ ...s, kind }))}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor={`${tabId}-count`} className="text-xs font-normal text-muted-foreground">
            How many
          </Label>
          <Input
            id={`${tabId}-count`}
            inputMode="numeric"
            value={state.count}
            aria-invalid={count.ok ? undefined : true}
            aria-describedby={count.ok ? undefined : `${tabId}-count-error`}
            onChange={(e) => {
              const text = e.target.value;
              update((s) => regenerate({ ...s, count: text }));
            }}
            className="h-7 w-20 font-mono text-xs"
          />
        </div>
        <Segmented
          label="Case"
          items={CASES}
          value={state.upper ? "upper" : "lower"}
          onChange={(c) => update((s) => ({ ...s, upper: c === "upper" }))}
        />
        {isUuid && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${tabId}-hyphens`}
              checked={state.hyphens}
              onCheckedChange={(v) => update((s) => ({ ...s, hyphens: v === true }))}
            />
            <Label htmlFor={`${tabId}-hyphens`} className="text-xs font-normal">
              Hyphens
            </Label>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7"
          disabled={!count.ok}
          onClick={() => update(regenerate)}
        >
          <RefreshCw /> Generate
        </Button>
      </div>
      {!count.ok && (
        <p
          id={`${tabId}-count-error`}
          role="alert"
          className="shrink-0 border-b px-3 py-1.5 text-xs text-destructive"
        >
          {count.error}
        </p>
      )}
      <section aria-label="Generated IDs" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            {ids ? (ids.ids.length === 1 ? "1 ID" : `${nf.format(ids.ids.length)} IDs`) : "IDs"}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy IDs"
                disabled={!output}
                onClick={() => void copy()}
              >
                <Copy />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy IDs</TooltipContent>
          </Tooltip>
        </div>
        <CodeEditor
          value={output}
          readOnly
          ariaLabel="Generated IDs"
          className="min-h-0 flex-1 overflow-auto border-t"
        />
      </section>
      <Inspector
        tabId={tabId}
        value={state.inspect}
        onChange={(inspect) => update((s) => ({ ...s, inspect }))}
      />
    </div>
  );
}

function Inspector({
  tabId,
  value,
  onChange,
}: {
  tabId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const result = useMemo(() => (value.trim() ? inspectId(value) : null), [value]);
  return (
    <section aria-label="Inspect an ID" className="shrink-0 border-t px-3 py-2.5">
      <Label htmlFor={`${tabId}-inspect`} className="mb-1.5 text-xs font-medium text-muted-foreground">
        Inspect an ID
      </Label>
      <Input
        id={`${tabId}-inspect`}
        value={value}
        placeholder="Paste a UUID or a ULID"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 font-mono text-xs"
      />
      {result &&
        (result.ok ? (
          <Details info={result.info} />
        ) : (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {result.error}
          </p>
        ))}
    </section>
  );
}

function Details({ info }: { info: Inspection }) {
  const rows: [string, React.ReactNode][] = [
    ["Type", info.type],
    ["Canonical form", <span className="font-mono text-xs">{info.canonical}</span>],
  ];
  if (info.type === "UUID") rows.push(["Version", info.version]);
  if (info.variant) rows.push(["Variant", info.variant]);
  if (info.timeMs !== undefined) {
    // 48-bit (ULID, v7) and 60-bit (v1, v6) times always fit in a Date.
    const date = new Date(info.timeMs);
    rows.push(
      ["Time (UTC)", <span className="font-mono text-xs">{date.toISOString()}</span>],
      ["Time (local)", date.toLocaleString()],
    );
  }
  return (
    <dl aria-label="ID details" className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
