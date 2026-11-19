import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ArrowLeftToLine, Braces, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { cn } from "@/lib/utils";
import type { ToolProps } from "../registry";
import { errorMarks, setErrorMark } from "./errorMark";
import { transformJson, type Indent, type JsonMode, type JsonResult } from "./json";
import type { JsonToolState } from "./state";

/** Text tools stop at 10 MiB instead of freezing the UI. */
export const MAX_JSON_INPUT = 10 * 1024 * 1024;
/** Inputs at least this long are processed after typing pauses, not on every keystroke. */
export const DEBOUNCE_FROM = 200_000;
export const DEBOUNCE_MS = 250;

const MODES: { id: JsonMode; label: string }[] = [
  { id: "format", label: "Format" },
  { id: "minify", label: "Minify" },
  { id: "escape", label: "Escape" },
  { id: "unescape", label: "Unescape" },
];

const INPUT_HINT: Record<JsonMode, string> = {
  format: "Paste JSON to format it",
  minify: "Paste JSON to minify it",
  escape: "Paste text (e.g. JSON) to turn it into a JSON string",
  unescape: 'Paste a JSON string, e.g. "{\\"id\\": 1}", to read its text',
};

/** `input`, or for large inputs its value once typing has paused. */
function useSettled(input: string): string {
  const [settled, setSettled] = useState(input);
  const large = input.length >= DEBOUNCE_FROM;
  useEffect(() => {
    if (!large) return;
    const timer = setTimeout(() => setSettled(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, large]);
  return large ? settled : input;
}

/** The JSON tool: input on the left, the result on the right, the mode and options above. */
export function JsonTool({ tabId, state, update }: ToolProps<JsonToolState>) {
  const layout = usePanelLayout("tool.json");
  const inputView = useRef<EditorView | null>(null);
  const settled = useSettled(state.input);
  const tooLarge = settled.length > MAX_JSON_INPUT;
  const result: JsonResult | null = useMemo(
    () =>
      tooLarge
        ? null
        : transformJson(settled, { mode: state.mode, indent: state.indent, sortKeys: state.sortKeys }),
    [settled, tooLarge, state.mode, state.indent, state.sortKeys],
  );
  const error = result && !result.ok ? result.error : null;
  const output = result?.ok ? result.output : "";
  const stale = settled !== state.input;

  // Mark the error in the input (cleared while the result is out of date).
  const errorOffset = error && !stale ? error.offset : null;
  useEffect(() => {
    inputView.current?.dispatch({ effects: setErrorMark.of(errorOffset) });
  }, [errorOffset]);

  const set = (patch: Partial<JsonToolState>) => update((s) => ({ ...s, ...patch }));

  const goToError = () => {
    const v = inputView.current;
    if (!v || !error) return;
    v.dispatch({ selection: { anchor: Math.min(error.offset, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      toast.success("Output copied");
    } catch {
      toast.error("Couldn't copy the output", { description: "The clipboard isn't available." });
    }
  };

  const structural = state.mode === "format" || state.mode === "minify";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Braces aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">JSON formatter</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <div role="radiogroup" aria-label="Mode" className="flex gap-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={state.mode === m.id}
              onClick={() => set({ mode: m.id })}
              className={cn(
                "h-6 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                state.mode === m.id && "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        {state.mode === "format" && (
          <div className="flex items-center gap-2">
            <Label htmlFor={`${tabId}-indent`} className="text-xs font-normal text-muted-foreground">
              Indent
            </Label>
            <Select value={state.indent} onValueChange={(v) => set({ indent: v as Indent })}>
              <SelectTrigger id={`${tabId}-indent`} size="sm" className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2 spaces</SelectItem>
                <SelectItem value="4">4 spaces</SelectItem>
                <SelectItem value="tab">Tabs</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {structural && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${tabId}-sort`}
              checked={state.sortKeys}
              onCheckedChange={(v) => set({ sortKeys: v === true })}
            />
            <Label htmlFor={`${tabId}-sort`} className="text-xs font-normal">
              Sort keys
            </Label>
          </div>
        )}
      </div>
      <ResizablePanelGroup orientation="horizontal" id="pakpos-tool-json" {...layout}>
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
              language={state.mode === "escape" ? "text" : "json"}
              autoFocus={state.input === ""}
              ariaLabel="JSON input"
              placeholder={INPUT_HINT[state.mode]}
              extensions={errorMarks}
              onView={(v) => {
                inputView.current = v;
              }}
              className="min-h-0 flex-1 overflow-auto border-t"
            />
            <Status tooLarge={tooLarge} error={stale ? null : error} stale={stale} onGoToError={goToError} />
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
                  set({ input: output, mode: state.mode === "unescape" ? "format" : state.mode })
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
              language={state.mode === "unescape" ? "text" : "json"}
              ariaLabel="JSON output"
              placeholder={state.input ? "" : "The result shows here as you type."}
              className="min-h-0 flex-1 overflow-auto border-t"
            />
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

function Status({
  tooLarge,
  error,
  stale,
  onGoToError,
}: {
  tooLarge: boolean;
  error: { message: string; line: number; column: number } | null;
  stale: boolean;
  onGoToError: () => void;
}) {
  const line = "flex min-h-9 shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs";
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
    <div className={line}>
      <p role="alert" className="min-w-0 flex-1 text-destructive">
        Line {error.line}, column {error.column}: {error.message}
      </p>
      <Button size="xs" variant="outline" onClick={onGoToError}>
        Go to error
      </Button>
    </div>
  );
}
