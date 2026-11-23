import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Copy, Globe, Play, Save, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DocKindIcon } from "@/features/scopes/DocKindIcon";
import { errorMessage } from "@/lib/errors";
import { isRunning, statusKey, webhookUrl, type WebhookStatus } from "@/lib/webhookModel";
import { isDirty, useTabSection, useTabsStore, type Tab } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";
import { RunDot } from "./WebhooksSidebar";
import { CloudflaredPanel } from "./CloudflaredPanel";
import { RequestLog } from "./RequestLog";
import { RulesEditor } from "./RulesEditor";
import { copyText, loadWebhookTab, saveWebhookTab } from "./actions";
import { startWebhook } from "./start";
import { statusText } from "./format";

const SECTIONS = ["requests", "rules"] as const;

/** A webhook tab: its URL and state, the requests it received, and its rules. */
export function WebhookView({ tab }: { tab: Tab }) {
  const doc = tab.doc!;
  const webhookId = doc.targetId;
  const currentWs = useWorkspaceStore((s) => s.workspace?.id ?? "");
  const readOnly = tab.workspaceId !== currentWs;
  const st = useWebhooksStore((s) => s.statuses[statusKey(tab.workspaceId, webhookId)]);
  const prompt = useWebhooksStore((s) => s.cloudflaredPrompt === webhookId);
  const [section, setSection] = useTabSection(tab, "webhook", SECTIONS, "requests");
  const draft = doc.webhook?.draft ?? null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const dirty = isDirty(tab);

  useEffect(() => {
    if (readOnly || draft) return;
    loadWebhookTab(tab.id).catch((e) => setLoadError(errorMessage(e)));
  }, [readOnly, draft, tab.id]);

  const running = isRunning(st);
  const url = webhookUrl(st);
  const store = useWebhooksStore.getState;
  const startTunnelAfterInstall = useCallback(() => {
    store().setCloudflaredPrompt(null);
    void startWebhook(webhookId, true);
  }, [store, webhookId]);
  const tunnelMissing = st?.state === "tunnel-failed" && /cloudflared isn't installed/i.test(st.message);

  return (
    <section aria-label={`Webhook ${doc.name}`} className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <DocKindIcon kind="webhook" className="size-4" />
        <h1 className="min-w-0 truncate text-sm font-semibold">{doc.name}</h1>
        <RunDot status={st} />
        <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
          {statusText(st)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!readOnly && dirty && (
            <Button size="sm" variant="outline" onClick={() => void saveWebhookTab(tab.id)}>
              <Save /> Save
            </Button>
          )}
          {running ? (
            <Button size="sm" variant="outline" onClick={() => void store().stop(tab.workspaceId, webhookId)}>
              <Square /> Stop
            </Button>
          ) : (
            !readOnly && <StartButton webhookId={webhookId} />
          )}
        </div>
      </header>

      {running && <UrlBar status={st} url={url} />}

      {readOnly && (
        <p role="note" className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          This webhook belongs to {st?.workspaceName ? `“${st.workspaceName}”` : "another workspace"}. Its log
          is shown here; open that workspace to change its rules.
        </p>
      )}
      {doc.missing && (
        <p role="alert" className="border-b bg-muted/40 px-4 py-2 text-xs text-destructive">
          This webhook was deleted outside the app. Copy your changes elsewhere, then close the tab.
        </p>
      )}
      {(prompt || tunnelMissing) && !readOnly && (
        <CloudflaredPanel
          onReady={startTunnelAfterInstall}
          onLocalOnly={() => {
            store().setCloudflaredPrompt(null);
            if (!running) void startWebhook(webhookId, false);
          }}
          onDismiss={() => store().setCloudflaredPrompt(null)}
        />
      )}

      {readOnly ? (
        <RequestLog webhookId={webhookId} baseUrl={url} />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Webhook views"
            className="flex h-9 shrink-0 items-end gap-4 border-b px-4"
          >
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={section === s}
                onClick={() => setSection(s)}
                className={
                  section === s
                    ? "border-b-2 border-primary pb-1.5 text-xs font-medium"
                    : "border-b-2 border-transparent pb-1.5 text-xs text-muted-foreground hover:text-foreground"
                }
              >
                {s === "requests"
                  ? "Requests"
                  : `Rules${draft?.rules.length ? ` (${draft.rules.length})` : ""}`}
              </button>
            ))}
          </div>
          {section === "requests" ? (
            <RequestLog
              webhookId={webhookId}
              baseUrl={url}
              onCreateRule={(rule) => {
                if (!draft) return;
                useTabsStore.getState().updateWebhook(tab.id, (w) => ({ ...w, rules: [...w.rules, rule] }));
                store().selectRule(tab.id, rule.id);
                setSection("rules");
              }}
            />
          ) : draft ? (
            <RulesEditor tabId={tab.id} webhook={draft} />
          ) : (
            <p role="status" className="p-6 text-center text-sm text-muted-foreground">
              {loadError ? `Couldn't load the webhook: ${loadError}` : "Loading the rules…"}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function StartButton({ webhookId }: { webhookId: string }) {
  return (
    <div className="flex">
      <Button size="sm" className="rounded-r-none" onClick={() => void startWebhook(webhookId, true)}>
        <Globe /> Start
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
            aria-label="More ways to start"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void startWebhook(webhookId, true)}>
            <Globe /> Start with public tunnel
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void startWebhook(webhookId, false)}>
            <Play /> Start local only
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function UrlBar({ status, url }: { status: WebhookStatus; url: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
      <span className="shrink-0 text-xs text-muted-foreground">
        {status.publicUrl ? "Public URL" : "Local URL"}
      </span>
      <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1 font-mono text-xs select-all">
        {url}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy URL"
            onClick={() => void copyText(url, "URL")}
          >
            <Copy />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy URL</TooltipContent>
      </Tooltip>
      {status.publicUrl && (
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground lg:inline">
          → {status.localUrl}
        </span>
      )}
    </div>
  );
}
