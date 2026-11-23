import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, ListPlus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { ConfirmDeleteDialog, type DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import { formatDuration, statusTextClass } from "@/features/response/format";
import { errorMessage, plural } from "@/lib/errors";
import { methodTextClass } from "@/lib/http";
import {
  curlFor,
  formatSize,
  headerValue,
  languageFor,
  requestFor,
  requestTarget,
  ruleFromRequest,
  type WebhookBody,
  type WebhookHeader,
  type WebhookRequestDetail,
  type WebhookRequestSummary,
  type WebhookRule,
} from "@/lib/webhookModel";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { useWebhooksStore, type WebhookLog } from "@/stores/webhooks";
import { api } from "@/lib/api";
import { copyText } from "./actions";
import { clockTime, matchesFilter } from "./format";

const EMPTY_LOG: WebhookLog = { entries: [], loaded: false, loading: false, hasMore: false, error: null };

/** The requests a webhook received (newest first) and the selected one in full. */
export function RequestLog({
  webhookId,
  baseUrl,
  onCreateRule,
}: {
  webhookId: string;
  /** The running webhook's URL ("" when stopped), used by cURL and "Open as request". */
  baseUrl: string;
  /** Adds a rule matching a request; absent when rules can't be edited here. */
  onCreateRule?: (rule: WebhookRule) => void;
}) {
  const log = useWebhooksStore((s) => s.logs[webhookId]) ?? EMPTY_LOG;
  const store = useWebhooksStore.getState;
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState<DeleteTarget | null>(null);

  useEffect(() => {
    void useWebhooksStore.getState().loadLog(webhookId);
  }, [webhookId]);

  const shown = useMemo(() => log.entries.filter((e) => matchesFilter(e, filter)), [log.entries, filter]);
  const selected = shown.find((e) => e.id === selectedId) ?? shown[0] ?? null;

  if (!log.loaded) {
    return (
      <p role="status" className="p-6 text-center text-sm text-muted-foreground">
        {log.error ? `Couldn't load the requests: ${log.error}` : "Loading requests…"}
      </p>
    );
  }

  if (log.entries.length === 0) {
    const example = `curl -X POST ${baseUrl || "<webhook URL>"} -H 'Content-Type: application/json' -d '{"hello": "world"}'`;
    return (
      <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">No requests yet.</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {baseUrl
            ? "Send a request to the URL above, or paste it into the service that sends the webhook. Requests show up here as they arrive."
            : "Start the webhook, then send a request to its URL. Requests show up here as they arrive."}
        </p>
        <code className="max-w-full rounded-sm bg-muted px-2 py-1 font-mono text-xs break-all">
          {example}
        </code>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Received requests" className="flex w-96 shrink-0 flex-col border-r">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Filter requests"
              placeholder="Filter by method, path, status or rule"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setPendingClear({
                title: "Clear this webhook's log?",
                description: `All ${plural(log.entries.length, "stored request")} are deleted from this machine. This can't be undone.`,
                confirmLabel: "Clear log",
                onConfirm: () => {
                  setSelectedId(null);
                  void store().clearLog(webhookId);
                },
              })
            }
          >
            Clear log
          </Button>
        </div>
        <ul aria-label="Requests" className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-current={selected?.id === e.id ? "true" : undefined}
                onClick={() => setSelectedId(e.id)}
                className={cn(
                  "flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  selected?.id === e.id && "bg-accent",
                )}
              >
                <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
                  {clockTime(e.receivedAt)}
                </span>
                <span className={cn("w-12 shrink-0 font-mono font-medium", methodTextClass(e.method))}>
                  {e.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{requestTarget(e)}</span>
                <span className={cn("shrink-0 font-mono tabular-nums", statusTextClass(e.status))}>
                  {e.error && !e.status ? "—" : e.status}
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="p-4 text-center text-xs text-muted-foreground">No requests match “{filter}”.</li>
          )}
        </ul>
        <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">
          <span>{plural(log.entries.length, "request")}</span>
          {log.hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              disabled={log.loading}
              onClick={() => void store().loadMore(webhookId)}
            >
              Load older
            </Button>
          )}
        </div>
      </aside>
      {selected ? (
        <RequestDetail
          key={selected.id}
          entry={selected}
          webhookId={webhookId}
          baseUrl={baseUrl}
          onCreateRule={onCreateRule}
          onDeleted={() => setSelectedId(null)}
        />
      ) : (
        <p role="status" className="flex-1 p-6 text-center text-sm text-muted-foreground">
          Select a request to see it in full.
        </p>
      )}
      <ConfirmDeleteDialog target={pendingClear} onClose={() => setPendingClear(null)} />
    </div>
  );
}

const DETAIL_TABS = ["request", "response"] as const;

function RequestDetail({
  entry,
  webhookId,
  baseUrl,
  onCreateRule,
  onDeleted,
}: {
  entry: WebhookRequestSummary;
  webhookId: string;
  baseUrl: string;
  onCreateRule?: (rule: WebhookRule) => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<WebhookRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<(typeof DETAIL_TABS)[number]>("request");

  useEffect(() => {
    let live = true;
    api
      .webhookRequest(entry.id)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [entry.id]);

  const target = baseUrl || "http://localhost:3000";
  return (
    <section aria-label="Request details" className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <span className={cn("font-mono text-sm font-semibold", methodTextClass(entry.method))}>
          {entry.method}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{requestTarget(entry)}</span>
        <span className="text-xs text-muted-foreground">
          {new Date(entry.receivedAt).toLocaleString()} · from {entry.remoteAddr || "unknown"} ·{" "}
          {formatDuration(entry.durationMs)}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5">
        <span className="mr-2 text-xs">
          Replied{" "}
          <span className={cn("font-mono font-medium", statusTextClass(entry.status))}>
            {entry.status || "—"}
          </span>{" "}
          <span className="text-muted-foreground">
            {entry.ruleName
              ? `by rule “${entry.ruleName}”`
              : entry.ruleId
                ? "by an unnamed rule"
                : "with the default response"}
          </span>
          {entry.error && <span className="ml-2 text-destructive">{entry.error}</span>}
        </span>
        <span className="ml-auto" />
        {onCreateRule && (
          <Button variant="ghost" size="sm" onClick={() => onCreateRule(ruleFromRequest(entry))}>
            <ListPlus /> Create rule
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!detail}
          onClick={() => detail && void copyText(curlFor(detail, target), "cURL command")}
        >
          <Copy /> Copy as cURL
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!detail}
          onClick={() => detail && useTabsStore.getState().openDraft(requestFor(detail, target))}
        >
          <ExternalLink /> Open as request
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete this request"
              className="ml-1 border-l pl-1"
              onClick={() => {
                onDeleted();
                void useWebhooksStore.getState().deleteEntry(webhookId, entry.id);
              }}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete this request from the log</TooltipContent>
        </Tooltip>
      </div>
      <div
        role="tablist"
        aria-label="Request or reply"
        className="flex h-8 shrink-0 items-end gap-4 border-b px-4"
      >
        {DETAIL_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={view === t}
            onClick={() => setView(t)}
            className={
              view === t
                ? "border-b-2 border-primary pb-1 text-xs font-medium"
                : "border-b-2 border-transparent pb-1 text-xs text-muted-foreground hover:text-foreground"
            }
          >
            {t === "request" ? "Request" : "Reply sent"}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          Couldn&apos;t load the request: {error}
        </p>
      ) : !detail ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : view === "request" ? (
        <Message headers={detail.headers} body={detail.body} size={entry.bodySize} label="Request" />
      ) : (
        <Message headers={detail.responseHeaders} body={detail.responseBody} label="Reply" />
      )}
    </section>
  );
}

function Message({
  headers,
  body,
  size,
  label,
}: {
  headers: WebhookHeader[];
  body: WebhookBody;
  size?: number;
  label: string;
}) {
  const language = languageFor(headerValue(headers, "Content-Type"), body.text);
  const hasBody = body.binary || body.text !== "";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">Headers</h3>
      <table aria-label={`${label} headers`} className="mx-4 text-xs">
        <tbody>
          {headers.map((h, i) => (
            <tr key={`${h.name}-${i}`} className="border-b last:border-b-0">
              <th
                scope="row"
                className="w-56 py-1 pr-3 text-left align-top font-mono font-normal text-muted-foreground"
              >
                {h.name}
              </th>
              <td className="py-1 font-mono break-all">{h.value}</td>
            </tr>
          ))}
          {headers.length === 0 && (
            <tr>
              <td className="py-1 text-muted-foreground">No headers</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <h3 className="text-xs font-medium text-muted-foreground">Body</h3>
        {size !== undefined && size > 0 && (
          <span className="text-[11px] text-muted-foreground">{formatSize(size)}</span>
        )}
        {body.truncated && (
          <span className="text-[11px] text-status-client">Only the first 1 MB was kept</span>
        )}
        {hasBody && !body.binary && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-[11px]"
            onClick={() => void copyText(body.text, "Body")}
          >
            <Copy /> Copy body
          </Button>
        )}
      </div>
      {!hasBody ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No body</p>
      ) : body.binary ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          Binary data ({formatSize(Math.floor((body.base64.length * 3) / 4))}), not shown.
        </p>
      ) : (
        <div className="mx-4 mb-4 min-h-40 flex-1 overflow-hidden rounded-md border">
          <CodeEditor
            value={body.text}
            language={language}
            readOnly
            gutters
            ariaLabel={`${label} body`}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
