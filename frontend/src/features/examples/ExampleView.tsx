import { useMemo } from "react";
import { BookmarkCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponseBody } from "@/features/response/ResponseBody";
import { HeadersTable } from "@/features/response/ResponseTables";
import { formatBytes, statusTextClass } from "@/features/response/format";
import { exampleToResponse, statusName, type Example } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useExamplesStore } from "@/stores/examples";
import { savedLabel } from "./saveState";

/** A saved example, read-only, in place of the tab's last response. */
export function ExampleView({
  tabId,
  example,
  hasResult,
}: {
  tabId: string;
  example: Example;
  hasResult: boolean;
}) {
  const response = useMemo(() => exampleToResponse(example.response), [example.response]);
  const status = statusName(response.statusCode, response.statusText);
  const saved = savedLabel(example.savedAt);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="note"
        aria-label={`Example: ${example.name}`}
        className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-3 text-xs"
      >
        <BookmarkCheck aria-hidden className="size-3.5 shrink-0 text-primary" />
        <p className="min-w-0 truncate">
          <span className="text-muted-foreground">Example:</span>{" "}
          <span className="font-medium text-foreground">{example.name}</span>
          {saved && <span className="text-muted-foreground"> · saved {saved}</span>}
        </p>
        <Button
          variant="outline"
          size="xs"
          className="ml-auto shrink-0"
          onClick={() => useExamplesStore.getState().hide(tabId)}
        >
          <Undo2 /> {hasResult ? "Back to last response" : "Close example"}
        </Button>
      </div>
      <Tabs key={example.id} defaultValue="body" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-3 pl-3">
          <TabsList variant="line" className="h-9 justify-start rounded-none p-0">
            <TabsTrigger value="body" className="flex-none px-2">
              Body
            </TabsTrigger>
            <TabsTrigger value="headers" className="flex-none px-2">
              Headers
              {response.headers.length > 0 && (
                <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground tabular-nums">
                  {response.headers.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <span
              aria-label={`Status ${status}`}
              className={cn("font-mono font-semibold", statusTextClass(response.statusCode))}
            >
              {status}
            </span>
            <span
              className="text-muted-foreground tabular-nums"
              title={`${response.size.toLocaleString()} bytes`}
            >
              {formatBytes(response.size)}
            </span>
          </div>
        </div>
        <TabsContent value="body" className="min-h-0 flex-1">
          <ResponseBody key={example.id} response={response} historyId={0} />
        </TabsContent>
        <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto">
          <HeadersTable headers={response.headers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
