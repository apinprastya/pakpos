import { useState } from "react";
import { toast } from "sonner";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HTTP_METHODS, methodTextClass, type HttpMethod } from "@/lib/http";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "params", label: "Params", hint: "Query and path parameters" },
  { id: "headers", label: "Headers", hint: "Request headers" },
  { id: "body", label: "Body", hint: "Request body" },
  { id: "auth", label: "Auth", hint: "Authorization" },
] as const;

/** Request editor shell. Editing state moves into a tab store in M4; sending lands in M1/M3. */
export function RequestPane() {
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("");

  const send = () => {
    if (!url.trim()) return;
    toast.info("Sending isn't connected yet", {
      description: "The request engine is the next milestone.",
    });
  };

  return (
    <section aria-label="Request" className="flex h-full min-h-0 flex-col">
      <form
        className="flex shrink-0 items-center gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex h-9 flex-1 items-center rounded-md border bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
          <Select value={method} onValueChange={(v) => setMethod(v as HttpMethod)}>
            <SelectTrigger
              aria-label="HTTP method"
              className={cn(
                "h-full! w-28 rounded-r-none border-0 border-r bg-transparent! font-mono text-xs font-bold shadow-none focus-visible:ring-0",
                methodTextClass(method),
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem
                  key={m}
                  value={m}
                  className={cn("font-mono text-xs font-bold", methodTextClass(m))}
                >
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            aria-label="Request URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="https://api.example.com/users/:id"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <Button type="submit" disabled={!url.trim()} className="h-9 px-4">
          <SendHorizontal /> Send
        </Button>
      </form>

      <Tabs defaultValue="params" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="h-9 w-full shrink-0 justify-start rounded-none border-b px-3">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.id} value={s.id} className="flex-none px-2">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTIONS.map((s) => (
          <TabsContent
            key={s.id}
            value={s.id}
            className="min-h-0 flex-1 overflow-auto p-3 text-muted-foreground"
          >
            {s.hint} editor arrives in a later milestone.
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
