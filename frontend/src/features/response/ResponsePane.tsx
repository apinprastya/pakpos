import { CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cancelTab } from "@/features/request/actions";
import { modKeyLabel } from "@/lib/platform";
import type { SendError } from "@/lib/model";
import { useActiveTab } from "@/stores/tabs";
import { errorCopy } from "./format";
import { ResponseBody } from "./ResponseBody";
import { ResponseMeta } from "./ResponseMeta";
import { CookiesTable, HeadersTable } from "./ResponseTables";

export function ResponsePane() {
  const tab = useActiveTab();
  const result = tab.result;
  const response = result?.response ?? null;
  const sending = tab.sendId !== null;

  let content: React.ReactNode;
  if (sending) {
    content = (
      <Centered>
        <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Sending request…</p>
        <Button variant="outline" size="sm" onClick={() => void cancelTab(tab.id)}>
          Cancel
        </Button>
      </Centered>
    );
  } else if (result?.error) {
    content = <ErrorState error={result.error} />;
  } else if (response) {
    content = (
      <Tabs key={tab.id} defaultValue="body" className="flex h-full min-h-0 flex-col gap-0">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-3 pl-3">
          <TabsList variant="line" className="h-9 justify-start rounded-none p-0">
            <TabsTrigger value="body" className="flex-none px-2">
              Body
            </TabsTrigger>
            <TabsTrigger value="headers" className="flex-none px-2">
              Headers <Count n={response.headers.length} />
            </TabsTrigger>
            <TabsTrigger value="cookies" className="flex-none px-2">
              Cookies <Count n={response.cookies.length} />
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto">
            <ResponseMeta response={response} />
          </div>
        </div>
        <TabsContent value="body" className="min-h-0 flex-1">
          <ResponseBody key={result?.historyId} response={response} historyId={result?.historyId ?? 0} />
        </TabsContent>
        <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto">
          <HeadersTable headers={response.headers} />
        </TabsContent>
        <TabsContent value="cookies" className="min-h-0 flex-1 overflow-auto">
          <CookiesTable cookies={response.cookies} />
        </TabsContent>
      </Tabs>
    );
  } else {
    content = (
      <Centered>
        <p className="text-muted-foreground">Enter a URL and send the request to see the response here.</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>{modKeyLabel()}</Kbd>
          <Kbd>Enter</Kbd>
          <span className="ml-1">sends the request</span>
        </p>
      </Centered>
    );
  }

  return (
    <section aria-label="Response" aria-busy={sending} className="flex h-full min-h-0 flex-col">
      {!response || sending || result?.error ? (
        <header className="flex h-9 shrink-0 items-center border-b px-3 text-sm font-semibold">
          Response
        </header>
      ) : null}
      <div className="min-h-0 flex-1">{content}</div>
    </section>
  );
}

function ErrorState({ error }: { error: SendError }) {
  const copy = errorCopy(error.kind);
  const cancelled = error.kind === "canceled";
  return (
    <Centered>
      {!cancelled && <CircleAlert aria-hidden className="size-5 text-destructive" />}
      <h2 className="font-semibold">{copy.title}</h2>
      {!cancelled && error.message && (
        <p className="selectable max-w-md font-mono text-xs break-words text-muted-foreground">
          {error.message}
        </p>
      )}
      {copy.hint && <p className="max-w-md text-xs text-muted-foreground">{copy.hint}</p>}
    </Centered>
  );
}

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground tabular-nums">{n}</span>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {children}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}
