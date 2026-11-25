import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { displayUrl, statusLabel } from "@/features/sidebar/historyFormat";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { methodTextClass } from "@/lib/http";
import type { HistoryEntry, HistorySummary } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useHistoryCompareStore } from "@/stores/historyCompare";
import { diffLines, diffStats, toHunks, type DiffLine, type Hunk } from "./diff";
import { requestText, responseText, type TextOptions } from "./entryText";

/** Compares two history entries: the response and the request, as line diffs. */
export function CompareDialog() {
  const pair = useHistoryCompareStore((s) => s.pair);
  return (
    <Dialog open={!!pair} onOpenChange={(o) => !o && useHistoryCompareStore.getState().close()}>
      {pair && <CompareBody key={`${pair.a.id}:${pair.b.id}`} a={pair.a} b={pair.b} />}
    </Dialog>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; a: HistoryEntry; b: HistoryEntry };

function CompareBody({ a, b }: { a: HistorySummary; b: HistorySummary }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [sortKeys, setSortKeys] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api.historyGet(a.id), api.historyGet(b.id)]).then(
      ([ea, eb]) => live && setLoaded({ state: "ready", a: ea, b: eb }),
      (e: unknown) => live && setLoaded({ state: "error", message: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [a.id, b.id]);

  return (
    <DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-5xl">
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Compare history entries</DialogTitle>
        <DialogDescription className="sr-only">
          Lines only in the earlier entry are marked removed, lines only in the later one added.
        </DialogDescription>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          <EntryLabel sign="−" label="Earlier" item={a} />
          <EntryLabel sign="+" label="Later" item={b} />
        </dl>
      </DialogHeader>
      {loaded.state === "loading" ? (
        <p className="p-5 text-sm text-muted-foreground">Loading the entries…</p>
      ) : loaded.state === "error" ? (
        <p role="alert" className="p-5 text-sm text-destructive">
          Couldn't load the entries: {loaded.message}
        </p>
      ) : (
        <CompareTabs a={loaded.a} b={loaded.b} sortKeys={sortKeys} onSortKeys={setSortKeys} />
      )}
    </DialogContent>
  );
}

function EntryLabel({ sign, label, item }: { sign: string; label: string; item: HistorySummary }) {
  return (
    <>
      <dt className="font-mono text-muted-foreground" aria-label={label}>
        {sign}
      </dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className={cn("font-mono font-semibold", methodTextClass(item.method))}>{item.method}</span>
        <span className="min-w-0 truncate font-mono">{displayUrl(item.url)}</span>
        <span className="shrink-0 text-muted-foreground">
          {statusLabel(item)} · {new Date(item.createdAt).toLocaleString()}
          {item.environmentName ? ` · ${item.environmentName}` : ""}
        </span>
      </dd>
    </>
  );
}

function CompareTabs({
  a,
  b,
  sortKeys,
  onSortKeys,
}: {
  a: HistoryEntry;
  b: HistoryEntry;
  sortKeys: boolean;
  onSortKeys: (v: boolean) => void;
}) {
  const response = useMemo(() => {
    const opts: TextOptions = { sortKeys };
    return diffLines(responseText(a, opts), responseText(b, opts));
  }, [a, b, sortKeys]);
  const request = useMemo(() => {
    const opts: TextOptions = { sortKeys };
    return diffLines(requestText(a, opts), requestText(b, opts));
  }, [a, b, sortKeys]);
  return (
    <Tabs defaultValue="response" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <TabsList variant="line" className="h-9 justify-start rounded-none p-0">
          <TabsTrigger value="response" className="flex-none px-2">
            Response <Stats lines={response} />
          </TabsTrigger>
          <TabsTrigger value="request" className="flex-none px-2">
            Request <Stats lines={request} />
          </TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          <Switch id="compare-sort-keys" checked={sortKeys} onCheckedChange={onSortKeys} />
          <Label htmlFor="compare-sort-keys" className="text-xs font-normal">
            Ignore JSON key order
          </Label>
        </div>
      </div>
      <TabsContent value="response" className="min-h-0 flex-1 overflow-auto">
        <DiffView lines={response} what="responses" />
      </TabsContent>
      <TabsContent value="request" className="min-h-0 flex-1 overflow-auto">
        <DiffView lines={request} what="requests" />
      </TabsContent>
    </Tabs>
  );
}

function Stats({ lines }: { lines: DiffLine[] | null }) {
  if (!lines) return null;
  const { added, deleted } = diffStats(lines);
  if (!added && !deleted) return <span className="ml-1 text-xs text-muted-foreground">same</span>;
  return (
    <span className="ml-1 font-mono text-xs">
      <span className="text-status-ok">+{added}</span> <span className="text-destructive">−{deleted}</span>
    </span>
  );
}

function DiffView({ lines, what }: { lines: DiffLine[] | null; what: string }) {
  if (lines === null) {
    return (
      <p className="p-5 text-sm text-muted-foreground">
        These {what} differ in too many lines to compare line by line.
      </p>
    );
  }
  const changed = lines.some((l) => l.op !== "same");
  return (
    <div className="min-w-max">
      {!changed && <p className="px-5 py-3 text-sm text-muted-foreground">The {what} are the same.</p>}
      <ol aria-label={`Differences between the ${what}`} className="font-mono text-xs leading-5">
        {toHunks(lines).map((h, i) => (
          <HunkView key={i} hunk={h} />
        ))}
      </ol>
    </div>
  );
}

function HunkView({ hunk }: { hunk: Hunk }) {
  const [open, setOpen] = useState(false);
  if (hunk.kind === "gap" && !open) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full bg-muted/50 px-3 py-0.5 text-left font-sans text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          Show {hunk.lines.length === 1 ? "1 unchanged line" : `${hunk.lines.length} unchanged lines`}
        </button>
      </li>
    );
  }
  return hunk.lines.map((l, i) => <Row key={i} line={l} />);
}

const SIGN = { same: " ", add: "+", del: "−" } as const;
const LABEL = { same: "unchanged", add: "added", del: "removed" } as const;

function Row({ line }: { line: DiffLine }) {
  return (
    <li
      aria-label={`${LABEL[line.op]}: ${line.text}`}
      className={cn(
        "flex whitespace-pre",
        line.op === "add" && "bg-status-ok/10",
        line.op === "del" && "bg-destructive/10",
      )}
    >
      <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.a ?? ""}</span>
      <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.b ?? ""}</span>
      <span
        aria-hidden
        className={cn(
          "w-4 shrink-0 select-none",
          line.op === "add" && "text-status-ok",
          line.op === "del" && "text-destructive",
        )}
      >
        {SIGN[line.op]}
      </span>
      <span className="pr-4">{line.text || " "}</span>
    </li>
  );
}
