import { toast } from "sonner";
import { WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeEditor } from "@/components/editor/CodeEditor";
import type { BodyType, RawLanguage, Request } from "@/lib/model";
import { cn } from "@/lib/utils";
import { FilePicker } from "./FilePicker";
import { FormDataTable } from "./FormDataTable";
import { KeyValueTable } from "./KeyValueTable";
import { formatJSON, formatXML } from "./beautify";

const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "raw", label: "Raw" },
  { value: "form-data", label: "Form data" },
  { value: "urlencoded", label: "URL-encoded" },
  { value: "binary", label: "Binary file" },
];

const LANGUAGES: { value: RawLanguage; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
  { value: "html", label: "HTML" },
  { value: "javascript", label: "JavaScript" },
  { value: "text", label: "Text" },
];

interface Props {
  tabKey?: string;
  request: Request;
  onChange: (update: (req: Request) => Request) => void;
}

export function BodySection({ tabKey, request, onChange }: Props) {
  const body = request.body;
  const setBody = (patch: Partial<Request["body"]>) =>
    onChange((r) => ({ ...r, body: { ...r.body, ...patch } }));
  const canBeautify = body.language === "json" || body.language === "xml";

  const beautify = () => {
    const out = body.language === "json" ? formatJSON(body.raw) : formatXML(body.raw);
    if (out === null) {
      toast.error(`The body isn't valid ${body.language.toUpperCase()}`, {
        description: "Fix the syntax, then try again.",
      });
      return;
    }
    setBody({ raw: out });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Body type" className="flex flex-wrap gap-1">
          {BODY_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={body.type === t.value}
              onClick={() => setBody({ type: t.value })}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                body.type === t.value && "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {body.type === "raw" && (
          <div className="ml-auto flex items-center gap-1">
            <Select value={body.language} onValueChange={(v) => setBody({ language: v as RawLanguage })}>
              <SelectTrigger size="sm" aria-label="Body language" className="h-7! w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canBeautify && (
              <Button variant="ghost" size="xs" onClick={beautify}>
                <WandSparkles /> Beautify
              </Button>
            )}
          </div>
        )}
      </div>

      {body.type === "none" && <p className="text-xs text-muted-foreground">This request has no body.</p>}
      {body.type === "raw" && (
        <div className="min-h-40 flex-1 overflow-hidden rounded-md border bg-card">
          <CodeEditor
            key={tabKey}
            ariaLabel="Request body"
            className="h-full"
            value={body.raw}
            language={body.language}
            onChange={(raw) => setBody({ raw })}
          />
        </div>
      )}
      {body.type === "form-data" && (
        <FormDataTable rows={body.formData} onChange={(formData) => setBody({ formData })} />
      )}
      {body.type === "urlencoded" && (
        <KeyValueTable
          label="URL-encoded fields"
          rows={body.urlEncoded}
          onChange={(urlEncoded) => setBody({ urlEncoded })}
        />
      )}
      {body.type === "binary" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">The file is sent as the body, byte for byte.</p>
          <FilePicker
            path={body.binaryPath}
            label="binary body"
            onChange={(binaryPath) => setBody({ binaryPath })}
          />
        </div>
      )}
    </div>
  );
}
