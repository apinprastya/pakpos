import { useState } from "react";
import {
  Copy,
  ExternalLink,
  FolderTree,
  Globe,
  MoreHorizontal,
  Pencil,
  Plus,
  Play,
  Square,
  Trash2,
  Webhook as WebhookIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDeleteDialog, type DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import { EmptyState } from "@/features/sidebar/EmptyState";
import { InlineRename } from "@/features/sidebar/InlineRename";
import { ItemMenuContent, type MenuEntry } from "@/features/sidebar/ItemMenu";
import { isRunning, statusKey, webhookUrl, type Webhook, type WebhookStatus } from "@/lib/webhookModel";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useActiveTab } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { useWorkspaceStore } from "@/stores/workspace";
import { copyText } from "./actions";
import { startWebhook } from "./start";

const rowClass =
  "group/row flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-1 pl-2 text-left text-[13px] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** The "Webhooks" sidebar view: the workspace's webhooks, and ones still running from other workspaces. */
export function WebhooksSidebar() {
  const status = useWorkspaceStore((s) => s.status);
  const workspace = useWorkspaceStore((s) => s.workspace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ForeignRunning workspaceId={workspace?.id ?? ""} />
      {status === "loading" ? (
        <EmptyState title="Loading workspace…" />
      ) : !workspace ? (
        <EmptyState
          icon={<WebhookIcon className="size-6" />}
          title="No workspace open"
          body="Webhooks belong to a workspace. Open or create one first."
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => useLayoutStore.getState().setSidebarView("collections")}
          >
            <FolderTree /> Go to collections
          </Button>
        </EmptyState>
      ) : (
        <WorkspaceWebhooks workspaceId={workspace.id} />
      )}
    </div>
  );
}

/** Webhooks running in a workspace that isn't open: they keep answering until stopped. */
function ForeignRunning({ workspaceId }: { workspaceId: string }) {
  const statuses = useWebhooksStore((s) => s.statuses);
  const foreign = Object.values(statuses).filter((s) => s.workspaceId !== workspaceId);
  if (foreign.length === 0) return null;
  return (
    <section aria-label="Running in other workspaces" className="shrink-0 border-b pb-1.5">
      <h2 className="flex h-8 items-center px-3 text-xs font-medium text-muted-foreground">
        Running in other workspaces
      </h2>
      <ul className="flex flex-col gap-px px-1.5">
        {foreign.map((s) => (
          <li key={statusKey(s.workspaceId, s.webhookId)} className="flex items-center gap-1 rounded-md pl-2">
            <RunDot status={s} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px]">{s.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{s.workspaceName}</span>
            </span>
            <IconAction
              label={`Copy the URL of ${s.name}`}
              onClick={() => void copyText(webhookUrl(s), "URL")}
            >
              <Copy />
            </IconAction>
            <IconAction
              label={`Open the log of ${s.name}`}
              onClick={() => useWebhooksStore.getState().open(s.webhookId, s.workspaceId, s.name)}
            >
              <ExternalLink />
            </IconAction>
            <IconAction
              label={`Stop ${s.name}`}
              onClick={() => void useWebhooksStore.getState().stop(s.workspaceId, s.webhookId)}
            >
              <Square />
            </IconAction>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A small dot: green when live, amber while the tunnel starts or after it failed. */
export function RunDot({ status, className }: { status: WebhookStatus | undefined; className?: string }) {
  if (!isRunning(status)) return null;
  const ok = status.state === "running";
  return (
    <span
      role="img"
      aria-label={
        ok ? "Running" : status.state === "tunnel-starting" ? "Starting the tunnel" : "Tunnel stopped"
      }
      className={cn(
        "size-2 shrink-0 rounded-full",
        ok ? "bg-status-ok" : "bg-status-client",
        status.state === "tunnel-starting" && "animate-pulse",
        className,
      )}
    />
  );
}

function WorkspaceWebhooks({ workspaceId }: { workspaceId: string }) {
  const status = useWebhooksStore((s) => s.status);
  const error = useWebhooksStore((s) => s.error);
  const webhooks = useWebhooksStore((s) => s.webhooks);
  const store = useWebhooksStore.getState;
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const confirmDelete = (w: Webhook) =>
    setPendingDelete({
      title: `Delete the webhook "${w.name}"?`,
      description:
        "Its file and its rules are removed from the workspace, and its request log is deleted from this machine. If it's running, it stops. This can't be undone.",
      confirmLabel: "Delete webhook",
      onConfirm: () => void store().remove(w.id),
    });

  let list: React.ReactNode;
  if (status === "loading" || status === "idle") {
    list = <EmptyState title="Loading webhooks…" />;
  } else if (status === "error") {
    list = (
      <EmptyState title="Couldn't load webhooks" body={error ?? undefined}>
        <Button size="sm" variant="outline" onClick={() => void store().load()}>
          Try again
        </Button>
      </EmptyState>
    );
  } else if (webhooks.length === 0) {
    list = (
      <EmptyState
        title="No webhooks yet"
        body="A webhook gives you a URL to paste into Stripe, GitHub or your own service. Every request it receives shows up here, and rules decide what it replies."
      >
        <Button size="sm" onClick={() => void store().create()}>
          <Plus /> Create webhook
        </Button>
      </EmptyState>
    );
  } else {
    list = (
      <ul aria-label="Webhooks" className="flex flex-col gap-px px-1.5 pb-2">
        {webhooks.map((w) => (
          <WebhookRow key={w.id} webhook={w} workspaceId={workspaceId} confirmDelete={confirmDelete} />
        ))}
      </ul>
    );
  }

  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Webhooks</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New webhook"
              disabled={status !== "ready"}
              onClick={() => void store().create()}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New webhook</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{list}</div>
      <p className="shrink-0 border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        Requests are kept on this device. A public URL is reachable by anyone who has it while the webhook
        runs.
      </p>
      <ConfirmDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </>
  );
}

function WebhookRow({
  webhook,
  workspaceId,
  confirmDelete,
}: {
  webhook: Webhook;
  workspaceId: string;
  confirmDelete: (w: Webhook) => void;
}) {
  const st = useWebhooksStore((s) => s.statuses[statusKey(workspaceId, webhook.id)]);
  const renameTarget = useWebhooksStore((s) => s.renameTarget);
  const active = useActiveTab();
  const store = useWebhooksStore.getState;
  const [renaming, setRenaming] = useState(false);
  const isRenaming = renaming || renameTarget === webhook.id;
  const open = active.doc?.kind === "webhook" && active.doc.targetId === webhook.id;
  const running = isRunning(st);

  const stopRename = () => {
    setRenaming(false);
    if (renameTarget === webhook.id) store().setRenameTarget(null);
  };

  const menu: MenuEntry[] = [
    { label: "Open", icon: ExternalLink, onSelect: () => store().open(webhook.id) },
    running
      ? { label: "Stop", icon: Square, onSelect: () => void store().stop(workspaceId, webhook.id) }
      : { label: "Start with tunnel", icon: Globe, onSelect: () => void startWebhook(webhook.id, true) },
    ...(running
      ? [{ label: "Copy URL", icon: Copy, onSelect: () => void copyText(webhookUrl(st), "URL") }]
      : [{ label: "Start local only", icon: Play, onSelect: () => void startWebhook(webhook.id, false) }]),
    "separator",
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(true) },
    { label: "Duplicate", icon: Copy, onSelect: () => void store().duplicate(webhook.id) },
    "separator",
    {
      label: "Delete",
      icon: Trash2,
      destructive: true,
      shortcut: "Del",
      onSelect: () => confirmDelete(webhook),
    },
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      setRenaming(true);
    } else if (e.key === "Delete") {
      e.preventDefault();
      confirmDelete(webhook);
    }
  };

  if (isRenaming) {
    return (
      <li className="flex h-8 items-center gap-2 pr-1 pl-2">
        <WebhookIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <InlineRename
          initial={webhook.name}
          label="Webhook name"
          onCommit={(name) => {
            stopRename();
            void store().rename(webhook.id, name);
          }}
          onCancel={stopRename}
        />
      </li>
    );
  }

  return (
    <li className="group/item relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={cn(rowClass, open && "bg-sidebar-accent")}
            aria-current={open ? "page" : undefined}
            onClick={() => store().open(webhook.id)}
            onKeyDown={onKeyDown}
          >
            <WebhookIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{webhook.name}</span>
            <RunDot status={st} className="mr-6" />
          </button>
        </ContextMenuTrigger>
        <ItemMenuContent kind="context" entries={menu} />
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${webhook.name}`}
            className="absolute top-1 right-1 size-6 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <ItemMenuContent kind="dropdown" entries={menu} />
      </DropdownMenu>
    </li>
  );
}
