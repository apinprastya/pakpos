import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { HTTP_METHODS, methodTextClass } from "@/lib/http";
import type { Request } from "@/lib/model";
import { cn } from "@/lib/utils";
import { setUrl } from "./edits";

interface Props {
  /** Remounts the editor per tab so undo history is per request. */
  tabKey: string;
  request: Request;
  sending: boolean;
  onChange: (update: (req: Request) => Request) => void;
  onSend: () => void;
  onCancel: () => void;
}

export function UrlBar({ tabKey, request, sending, onChange, onSend, onCancel }: Props) {
  const canSend = request.url.trim() !== "";
  return (
    <div className="flex shrink-0 items-center gap-2 p-3">
      <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
        <Select value={request.method} onValueChange={(method) => onChange((r) => ({ ...r, method }))}>
          <SelectTrigger
            aria-label="HTTP method"
            className={cn(
              "h-full! w-28 shrink-0 rounded-r-none border-0 border-r bg-transparent! font-mono text-xs font-bold shadow-none focus-visible:ring-0",
              methodTextClass(request.method),
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((m) => (
              <SelectItem key={m} value={m} className={cn("font-mono text-xs font-bold", methodTextClass(m))}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CodeEditor
          key={tabKey}
          singleLine
          ariaLabel="Request URL"
          placeholder="https://api.example.com/users/:id"
          className="flex h-full min-w-0 flex-1 items-center px-1 text-[13px] [&_.cm-editor]:w-full [&_.cm-scroller]:[scrollbar-width:none] [&_.cm-scroller]:overflow-x-auto"
          value={request.url}
          onChange={(url) => onChange((r) => setUrl(r, url))}
          onSubmit={onSend}
        />
      </div>
      {sending ? (
        <Button variant="secondary" className="h-9 w-24" onClick={onCancel}>
          <Square /> Cancel
        </Button>
      ) : (
        <Button className="h-9 w-24" disabled={!canSend} onClick={onSend}>
          <SendHorizontal /> Send
        </Button>
      )}
    </div>
  );
}
