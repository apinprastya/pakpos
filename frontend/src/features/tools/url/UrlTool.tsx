import { useMemo } from "react";
import { ArrowLeftToLine, Copy, ExternalLink, Link, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { setUrl } from "@/features/request/edits";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { emptyRequest } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import type { ToolProps } from "../registry";
import { MAX_TOOL_INPUT, useSettled } from "../useSettled";
import type { UrlToolState } from "./state";
import { errorText, parseUrl, transformUrl, type Direction, type UrlMode, type UrlParts } from "./url";

const MODES: { id: UrlMode; label: string; hint: string }[] = [
  {
    id: "component",
    label: "Component",
    hint: "A query value or path segment: everything but letters, digits and -_.!~*'() is encoded.",
  },
  { id: "form", label: "Form", hint: "A form body (application/x-www-form-urlencoded): spaces become +." },
  {
    id: "full",
    label: "Full URL",
    hint: "A whole URL: only characters a URL can't hold are encoded; :/?#&= keep their meaning.",
  },
];

const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: "encode", label: "Encode" },
  { id: "decode", label: "Decode" },
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

/** The URL tool: text on the left, encoded or decoded on the right, and the URL's parts below. */
export function UrlTool({ tabId, state, update }: ToolProps<UrlToolState>) {
  const layout = usePanelLayout("tool.url");
  const settled = useSettled(state.input);
  const stale = settled !== state.input;
  const tooLarge = settled.length > MAX_TOOL_INPUT;
  const result = useMemo(
    () => (tooLarge ? null : transformUrl(settled, state.mode, state.direction)),
    [settled, tooLarge, state.mode, state.direction],
  );
  const output = result?.ok ? result.output : "";
  const error = result && !result.ok ? errorText(settled, result.offset, result.problem) : "";
  // The parts of the URL as written, or (decoding) once decoded.
  const parts = useMemo(() => {
    if (tooLarge) return null;
    return parseUrl(settled) ?? (state.direction === "decode" && output ? parseUrl(output) : null);
  }, [settled, tooLarge, state.direction, output]);

  const set = (patch: Partial<UrlToolState>) => update((s) => ({ ...s, ...patch }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      toast.success("Output copied");
    } catch {
      toast.error("Couldn't copy the output", { description: "The clipboard isn't available." });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Link aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">URL encoder</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <Segmented
          label="Direction"
          items={DIRECTIONS}
          value={state.direction}
          onChange={(direction) => set({ direction })}
        />
        <Segmented label="Mode" items={MODES} value={state.mode} onChange={(mode) => set({ mode })} />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {MODES.find((m) => m.id === state.mode)!.hint}
        </p>
      </div>
      <ResizablePanelGroup orientation="horizontal" id="pakpos-tool-url" {...layout}>
        <ResizablePanel id="input" defaultSize="50" minSize="25">
          <section aria-label="Input" className="flex h-full min-h-0 flex-col">
            <PaneHeader title="Input">
              <IconButton
                label="Clear input"
                disabled={state.input === ""}
                onClick={() => set({ input: "" })}
              >
                <X />
              </IconButton>
            </PaneHeader>
            <CodeEditor
              key={tabId}
              value={state.input}
              onChange={(input) => set({ input })}
              gutters={false}
              autoFocus={state.input === ""}
              ariaLabel="URL input"
              placeholder={
                state.direction === "encode"
                  ? "Paste text or a URL to encode"
                  : "Paste encoded text, e.g. a%20b%26c"
              }
              className="min-h-0 flex-1 overflow-auto border-t"
            />
            <Status tooLarge={tooLarge} stale={stale} error={stale ? "" : error} />
          </section>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="output" minSize="25">
          <section aria-label="Output" className="flex h-full min-h-0 flex-col">
            <PaneHeader title="Output">
              <IconButton
                label="Use output as input"
                disabled={!output || stale}
                onClick={() =>
                  set({ input: output, direction: state.direction === "encode" ? "decode" : "encode" })
                }
              >
                <ArrowLeftToLine />
              </IconButton>
              <IconButton label="Copy output" disabled={!output || stale} onClick={() => void copy()}>
                <Copy />
              </IconButton>
            </PaneHeader>
            <CodeEditor
              value={output}
              readOnly
              gutters={false}
              ariaLabel="URL output"
              placeholder={state.input ? "" : "The result shows here as you type."}
              className="min-h-0 flex-1 overflow-auto border-t"
            />
            <ParsePanel parts={stale ? null : parts} hasInput={state.input.trim() !== ""} />
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function PaneHeader({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Status({ tooLarge, stale, error }: { tooLarge: boolean; stale: boolean; error: string }) {
  const line = "flex min-h-9 shrink-0 items-center border-t px-3 py-1.5 text-xs";
  if (tooLarge) {
    return (
      <p role="alert" className={cn(line, "text-destructive")}>
        Input is too large for this tool (over 10 MiB).
      </p>
    );
  }
  if (stale) {
    return (
      <p role="status" className={cn(line, "text-muted-foreground")}>
        Updating…
      </p>
    );
  }
  if (!error) return null;
  return (
    <p role="alert" className={cn(line, "text-destructive")}>
      {error}
    </p>
  );
}

function openAsRequest(url: string) {
  useTabsStore.getState().openDraft(setUrl(emptyRequest(), url));
}

/** The URL's parts, as the request editor would read them. */
function ParsePanel({ parts, hasInput }: { parts: UrlParts | null; hasInput: boolean }) {
  return (
    <section aria-label="Parse URL" className="flex max-h-[45%] shrink-0 flex-col border-t">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Parse URL</h2>
        <Button
          size="xs"
          variant="outline"
          disabled={!parts}
          onClick={() => parts && openAsRequest(parts.source)}
        >
          <ExternalLink /> Open as request
        </Button>
      </div>
      {!parts ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          {hasInput
            ? "This isn't a URL. A URL starts with a scheme, like https://, and fits on one line."
            : "Paste a URL to see its scheme, host, path and query."}
        </p>
      ) : (
        <div className="min-h-0 overflow-y-auto pb-2">
          <table className="w-full text-sm">
            <tbody>
              <Row label="Scheme" value={parts.scheme} />
              <Row label="Host" value={parts.host} />
              <Row label="Port" value={parts.port} />
              <Row label="Path" value={parts.path} />
              <Row label="Fragment" value={parts.fragment} />
            </tbody>
          </table>
          {parts.query.length > 0 && (
            <table aria-label="Query" className="mt-1 w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="w-2/5 py-1 pl-3 text-left font-medium">
                    Query key
                  </th>
                  <th scope="col" className="py-1 pr-3 pl-2 text-left font-medium">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {parts.query.map((q, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-0.5 pl-3 font-mono text-xs break-all">{q.key}</td>
                    <td className="py-0.5 pr-3 pl-2 font-mono text-xs break-all">{q.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="align-top">
      <th scope="row" className="w-24 py-0.5 pl-3 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="py-0.5 pr-3 font-mono text-xs break-all">
        {value || <span className="font-sans text-muted-foreground">none</span>}
      </td>
    </tr>
  );
}
