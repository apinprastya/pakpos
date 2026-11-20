import { useMemo, useState } from "react";
import { ArrowLeftToLine, Binary, Copy, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { ToolProps } from "../registry";
import { MAX_TOOL_INPUT, useSettled } from "../useSettled";
import { MAX_HEX_BYTES, bytesToBase64, transformBase64, type Alphabet, type Direction } from "./base64";
import type { Base64ToolState } from "./state";

const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: "encode", label: "Encode" },
  { id: "decode", label: "Decode" },
];

const ALPHABETS: { id: Alphabet; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Uses + and /" },
  { id: "url", label: "URL-safe", hint: "Uses - and _, safe in URLs and file names" },
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

const nf = new Intl.NumberFormat();

/** The Base64 tool: text on the left, encoded or decoded on the right. */
export function Base64Tool({ tabId, state, update }: ToolProps<Base64ToolState>) {
  const layout = usePanelLayout("tool.base64");
  const settled = useSettled(state.input);
  const stale = settled !== state.input;
  const tooLarge = settled.length > MAX_TOOL_INPUT;
  const result = useMemo(
    () =>
      tooLarge
        ? null
        : transformBase64(settled, state.direction, { alphabet: state.alphabet, padding: state.padding }),
    [settled, tooLarge, state.direction, state.alphabet, state.padding],
  );
  const [saving, setSaving] = useState(false);

  const output = result?.kind === "text" ? result.text : result?.kind === "binary" ? result.hex : "";
  const binary = result?.kind === "binary" ? result.bytes : null;
  const error = result?.kind === "error" ? result.message : "";

  const set = (patch: Partial<Base64ToolState>) => update((s) => ({ ...s, ...patch }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      toast.success("Output copied");
    } catch {
      toast.error("Couldn't copy the output", { description: "The clipboard isn't available." });
    }
  };

  const save = async (bytes: Uint8Array) => {
    setSaving(true);
    try {
      const path = await api.saveBytes("decoded.bin", bytesToBase64(bytes));
      if (path) toast.success("File saved", { description: path });
    } catch (e) {
      toast.error("Couldn't save the file", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Binary aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Base64</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <Segmented
          label="Direction"
          items={DIRECTIONS}
          value={state.direction}
          onChange={(direction) => set({ direction })}
        />
        {state.direction === "encode" ? (
          <>
            <Segmented
              label="Alphabet"
              items={ALPHABETS}
              value={state.alphabet}
              onChange={(alphabet) => set({ alphabet })}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${tabId}-padding`}
                checked={state.padding}
                onCheckedChange={(v) => set({ padding: v === true })}
              />
              <Label htmlFor={`${tabId}-padding`} className="text-xs font-normal">
                Padding (=)
              </Label>
            </div>
          </>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Reads either alphabet, with or without padding; spaces and line breaks are ignored.
          </p>
        )}
      </div>
      <ResizablePanelGroup orientation="horizontal" id="pakpos-tool-base64" {...layout}>
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
              ariaLabel="Base64 input"
              placeholder={
                state.direction === "encode" ? "Type or paste text to encode" : "Paste Base64 to decode"
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
                disabled={!output || stale || binary !== null}
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
            {binary && !stale && (
              <div className="flex min-h-9 shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  Binary data ({nf.format(binary.length)} bytes), shown as hex
                  {binary.length > MAX_HEX_BYTES ? `; the first ${nf.format(MAX_HEX_BYTES)} bytes` : ""}.
                </span>
                <Button size="xs" variant="outline" disabled={saving} onClick={() => void save(binary)}>
                  <Save /> Save to file…
                </Button>
              </div>
            )}
            <CodeEditor
              value={output}
              readOnly
              gutters={false}
              ariaLabel="Base64 output"
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
