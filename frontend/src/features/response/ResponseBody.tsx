import { useDeferredValue, useMemo, useRef, useState } from "react";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Copy, Download, ListFilter, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { saveResponseBody } from "@/features/request/actions";
import { BodyContextMenu } from "./BodyContextMenu";
import type { Response } from "@/lib/model";
import { cn } from "@/lib/utils";
import { stringifyJson } from "@/features/tools/json/json";
import { CLOSED_FILTER, useJsonFilterStore } from "@/stores/jsonFilter";
import { bodyText, editorLanguage, formatBytes, prettyBody } from "./format";
import { filterJson, parseBody, type FilterResult } from "./jsonpath";

type Mode = "pretty" | "raw" | "preview";

interface Props {
  response: Response;
  historyId: number;
  /** The tab the response belongs to; its JSONPath filter is kept per tab. */
  tabId?: string;
}

export function ResponseBody({ response, historyId, tabId = "" }: Props) {
  const canPreview = response.kind === "html" || response.kind === "image";
  const [mode, setMode] = useState<Mode>(response.kind === "image" ? "preview" : "pretty");
  const view = useRef<EditorView | null>(null);
  const raw = useMemo(() => bodyText(response), [response]);
  const pretty = useMemo(() => (mode === "pretty" ? prettyBody(response) : null), [mode, response]);
  const isBinary = response.kind === "binary";
  const isEmpty = response.kind === "empty" || (response.size === 0 && !response.body);
  const effective: Mode = mode === "preview" && !canPreview ? "pretty" : mode;
  const filter = useJsonFilterStore((s) => s.byTab[tabId] ?? CLOSED_FILTER);
  const setFilter = useJsonFilterStore((s) => s.set);
  const canFilter = response.kind === "json" && effective === "pretty";
  const filtering = canFilter && filter.open && filter.query.trim() !== "";
  const query = useDeferredValue(filter.query);
  const parsed = useMemo(() => (filtering ? parseBody(raw) : null), [filtering, raw]);
  const filtered = useMemo<FilterResult | null>(
    () => (filtering ? filterJson(parsed, query.trim()) : null),
    [filtering, parsed, query],
  );
  const filteredText = useMemo(
    () => (filtered?.ok ? stringifyJson({ type: "array", items: filtered.matches }, "2") : null),
    [filtered],
  );
  const text = filteredText ?? (effective === "pretty" ? (pretty?.text ?? raw) : raw);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Response copied");
    } catch {
      toast.error("Couldn't copy the response", { description: "The clipboard isn't available." });
    }
  };

  const modes: { id: Mode; label: string }[] = [
    { id: "pretty", label: "Pretty" },
    { id: "raw", label: "Raw" },
    ...(canPreview ? [{ id: "preview" as const, label: "Preview" }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-1.5">
        <div role="radiogroup" aria-label="Body view" className="flex gap-0.5">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={effective === m.id}
              onClick={() => setMode(m.id)}
              className={cn(
                "h-6 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                effective === m.id && "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {canFilter && (
            <IconButton
              label={filter.open ? "Hide JSONPath filter" : "Filter with JSONPath"}
              pressed={filter.open}
              onClick={() => setFilter(tabId, { open: !filter.open })}
            >
              <ListFilter />
            </IconButton>
          )}
          <IconButton
            label="Search in response"
            disabled={effective === "preview" || isBinary}
            onClick={() => view.current && openSearchPanel(view.current)}
          >
            <Search />
          </IconButton>
          <IconButton label="Copy response" disabled={isBinary || isEmpty} onClick={copy}>
            <Copy />
          </IconButton>
          <IconButton
            label="Save response to file"
            disabled={historyId === 0}
            onClick={() => void saveResponseBody(historyId)}
          >
            <Download />
          </IconButton>
        </div>
      </div>

      {canFilter && filter.open && (
        <JsonPathBar
          query={filter.query}
          result={filtered}
          onChange={(q) => setFilter(tabId, { query: q })}
          onClose={() => setFilter(tabId, { open: false })}
        />
      )}

      {response.truncated && (
        <Notice>
          Showing the first part of a {formatBytes(response.size)} response.{" "}
          {historyId > 0 ? (
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => void saveResponseBody(historyId)}
            >
              Save it to a file
            </button>
          ) : (
            "Save it to a file"
          )}{" "}
          to see all of it.
        </Notice>
      )}
      {effective === "pretty" && pretty?.note && !filteredText && <Notice>{pretty.note}</Notice>}

      <div className="min-h-0 flex-1 overflow-hidden border-t">
        {isEmpty ? (
          <Centered>The response has no body.</Centered>
        ) : isBinary ? (
          <Centered>
            This is binary data ({formatBytes(response.size)}). Save it to a file to open it in another app.
          </Centered>
        ) : effective === "preview" ? (
          <Preview response={response} text={raw} />
        ) : (
          <BodyContextMenu view={view} json={response.kind === "json"}>
            <CodeEditor
              ariaLabel="Response body"
              readOnly
              className="h-full"
              value={text}
              language={effective === "pretty" ? editorLanguage(response.kind) : "text"}
              onView={(v) => (view.current = v)}
            />
          </BodyContextMenu>
        )}
      </div>
    </div>
  );
}

function Preview({ response, text }: { response: Response; text: string }) {
  if (response.kind === "image") {
    const src =
      response.encoding === "base64"
        ? `data:${response.contentType || "image/*"};base64,${response.body}`
        : `data:${response.contentType || "image/svg+xml"};charset=utf-8,${encodeURIComponent(response.body)}`;
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/40 p-4">
        <img src={src} alt="Response image" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  // Empty sandbox: no scripts, no same-origin access, no forms.
  return <iframe title="HTML preview" sandbox="" srcDoc={text} className="h-full w-full bg-white" />;
}

/** The JSONPath input under the body toolbar, with the match count or the error. */
function JsonPathBar({
  query,
  result,
  onChange,
  onClose,
}: {
  query: string;
  result: FilterResult | null;
  onChange: (q: string) => void;
  onClose: () => void;
}) {
  const status =
    result === null
      ? "Type a JSONPath, e.g. $.items[*].id or $..[?@.price < 10]"
      : result.ok
        ? result.matches.length === 1
          ? "1 match"
          : `${result.matches.length} matches`
        : result.error;
  const failed = result !== null && !result.ok;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5">
      <input
        // Focus the field when the bar opens.
        autoFocus
        aria-label="JSONPath filter"
        aria-invalid={failed || undefined}
        aria-describedby="jsonpath-status"
        spellCheck={false}
        placeholder="$.items[*].id"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        className="h-6 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-invalid:border-destructive"
      />
      <span
        id="jsonpath-status"
        role="status"
        className={cn("shrink-0 truncate text-xs", failed ? "text-destructive" : "text-muted-foreground")}
      >
        {status}
      </span>
      <IconButton label="Close filter" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn(pressed && "bg-accent text-accent-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="shrink-0 border-t bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{children}</p>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <p className="max-w-sm">{children}</p>
    </div>
  );
}
