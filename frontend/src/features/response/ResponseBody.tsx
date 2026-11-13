import { useMemo, useRef, useState } from "react";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Copy, Download, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { saveResponseBody } from "@/features/request/actions";
import type { Response } from "@/lib/model";
import { cn } from "@/lib/utils";
import { bodyText, editorLanguage, formatBytes, prettyBody } from "./format";

type Mode = "pretty" | "raw" | "preview";

interface Props {
  response: Response;
  historyId: number;
}

export function ResponseBody({ response, historyId }: Props) {
  const canPreview = response.kind === "html" || response.kind === "image";
  const [mode, setMode] = useState<Mode>(response.kind === "image" ? "preview" : "pretty");
  const view = useRef<EditorView | null>(null);
  const raw = useMemo(() => bodyText(response), [response]);
  const pretty = useMemo(() => (mode === "pretty" ? prettyBody(response) : null), [mode, response]);
  const isBinary = response.kind === "binary";
  const isEmpty = response.kind === "empty" || (response.size === 0 && !response.body);
  const effective: Mode = mode === "preview" && !canPreview ? "pretty" : mode;
  const text = effective === "pretty" ? (pretty?.text ?? raw) : raw;

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
      {effective === "pretty" && pretty?.note && <Notice>{pretty.note}</Notice>}

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
          <CodeEditor
            ariaLabel="Response body"
            readOnly
            className="h-full"
            value={text}
            language={effective === "pretty" ? editorLanguage(response.kind) : "text"}
            onView={(v) => (view.current = v)}
          />
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
        <Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
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
