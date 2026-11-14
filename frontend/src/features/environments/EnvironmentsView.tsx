import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleOff,
  Copy,
  ExternalLink,
  FolderTree,
  Globe,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDeleteDialog, type DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import { EmptyState } from "@/features/sidebar/EmptyState";
import { InlineRename } from "@/features/sidebar/InlineRename";
import { ItemMenuContent, type MenuEntry } from "@/features/sidebar/ItemMenu";
import { plural } from "@/lib/errors";
import type { Environment } from "@/lib/model";
import { cn } from "@/lib/utils";
import { moveId, shiftId, useEnvironmentsStore } from "@/stores/environments";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

/** The "Environments" sidebar view: globals plus the workspace's environments. */
export function EnvironmentsView() {
  const status = useWorkspaceStore((s) => s.status);
  const workspace = useWorkspaceStore((s) => s.workspace);
  if (status === "loading") return <EmptyState title="Loading workspace…" />;
  if (!workspace) {
    return (
      <EmptyState
        icon={<Layers className="size-6" />}
        title="No workspace open"
        body="Environments belong to a workspace. Open or create one first."
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => useLayoutStore.getState().setSidebarView("collections")}
        >
          <FolderTree /> Go to collections
        </Button>
      </EmptyState>
    );
  }
  return <WorkspaceEnvironments />;
}

const rowClass =
  "group/row flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-1 pl-2 text-left text-[13px] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function WorkspaceEnvironments() {
  const status = useEnvironmentsStore((s) => s.status);
  const error = useEnvironmentsStore((s) => s.error);
  const environments = useEnvironmentsStore((s) => s.environments);
  const globals = useEnvironmentsStore((s) => s.globals);
  const store = useEnvironmentsStore.getState;
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = environments.map((e) => e.id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const next = over ? moveId(ids, String(active.id), String(over.id)) : null;
    if (next) void store().reorder(next);
  };

  const confirmDelete = (e: Environment) =>
    setPendingDelete({
      title: `Delete the environment "${e.name}"?`,
      description: `Its file and its ${plural(e.variables.length, "variable")} are removed from the workspace, and its secret values are deleted from this machine. This can't be undone.`,
      confirmLabel: "Delete environment",
      onConfirm: () => void store().remove(e.id),
    });

  let list: React.ReactNode;
  if (status === "loading" || status === "idle") {
    list = <EmptyState title="Loading environments…" />;
  } else if (status === "error") {
    list = (
      <EmptyState title="Couldn't load environments" body={error ?? undefined}>
        <Button size="sm" variant="outline" onClick={() => void store().load()}>
          Try again
        </Button>
      </EmptyState>
    );
  } else if (environments.length === 0) {
    list = (
      <EmptyState
        title="No environments yet"
        body="An environment holds values like {{baseUrl}} that change between Dev, Staging and Prod. Create your first one, then pick it in the environment menu next to the tabs."
      >
        <Button size="sm" onClick={() => void store().create()}>
          <Plus /> Create environment
        </Button>
      </EmptyState>
    );
  } else {
    list = (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul aria-label="Environments" className="flex flex-col gap-px px-1.5 pb-2">
            {environments.map((e) => (
              <EnvironmentRow key={e.id} env={e} ids={ids} confirmDelete={confirmDelete} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Environments</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New environment"
              disabled={status !== "ready"}
              onClick={() => void store().create()}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New environment</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-1.5 pb-1">
          <button
            type="button"
            className={rowClass}
            onClick={() => store().openGlobals()}
            title="Variables available in every request"
          >
            <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Globals</span>
            {globals && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {globals.variables.length}
              </span>
            )}
          </button>
        </div>
        <div className="mx-3 mb-1 border-t" />
        {list}
      </div>
      <ConfirmDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}

function EnvironmentRow({
  env,
  ids,
  confirmDelete,
}: {
  env: Environment;
  ids: string[];
  confirmDelete: (e: Environment) => void;
}) {
  const selected = useEnvironmentsStore((s) => s.selectedId === env.id);
  const renameTarget = useEnvironmentsStore((s) => s.renameTarget);
  const store = useEnvironmentsStore.getState;
  const [renaming, setRenaming] = useState(false);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: env.id });
  const isRenaming = renaming || renameTarget === env.id;
  const index = ids.indexOf(env.id);

  const stopRename = () => {
    setRenaming(false);
    if (renameTarget === env.id) store().setRenameTarget(null);
  };
  const shift = (delta: -1 | 1) => {
    const next = shiftId(ids, env.id, delta);
    if (!next) return;
    void store().reorder(next);
    // Keep focus on the moved row once the list re-renders.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-env-row="${env.id}"]`)?.focus());
  };

  const menu: MenuEntry[] = [
    { label: "Open", icon: ExternalLink, onSelect: () => store().open(env.id) },
    selected
      ? { label: "Stop using", icon: CircleOff, onSelect: () => void store().select("") }
      : { label: "Use this environment", icon: Check, onSelect: () => void store().select(env.id) },
    "separator",
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(true) },
    { label: "Duplicate", icon: Copy, onSelect: () => void store().duplicate(env.id) },
    ...(index > 0 ? [{ label: "Move up", icon: ArrowUp, shortcut: "Alt+↑", onSelect: () => shift(-1) }] : []),
    ...(index < ids.length - 1
      ? [{ label: "Move down", icon: ArrowDown, shortcut: "Alt+↓", onSelect: () => shift(1) }]
      : []),
    "separator",
    { label: "Delete", icon: Trash2, destructive: true, shortcut: "Del", onSelect: () => confirmDelete(env) },
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      shift(e.key === "ArrowUp" ? -1 : 1);
    } else if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const next = ids[index + (e.key === "ArrowUp" ? -1 : 1)];
      if (next) document.querySelector<HTMLElement>(`[data-env-row="${next}"]`)?.focus();
    } else if (e.key === "F2") {
      e.preventDefault();
      setRenaming(true);
    } else if (e.key === "Delete") {
      e.preventDefault();
      confirmDelete(env);
    }
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/item relative", isDragging && "z-10 opacity-70")}
    >
      {isRenaming ? (
        <div className="flex h-8 items-center gap-2 pr-1 pl-2">
          <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <InlineRename
            initial={env.name}
            label="Environment name"
            onCommit={(name) => {
              stopRename();
              void store().rename(env.id, name);
            }}
            onCancel={stopRename}
          />
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="relative">
              <button
                type="button"
                data-env-row={env.id}
                aria-current={selected ? "true" : undefined}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2 Delete"
                className={cn(rowClass, "pr-8", selected && "font-medium")}
                onClick={() => store().open(env.id)}
                onKeyDown={onKeyDown}
                {...listeners}
              >
                <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{env.name}</span>
                {selected && (
                  <span className="flex items-center gap-0.5 text-[11px] text-primary">
                    <Check aria-hidden className="size-3" />
                    In use
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground tabular-nums group-focus-within/item:invisible group-hover/item:invisible">
                  {env.variables.length}
                </span>
              </button>
              <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`More actions for ${env.name}`}
                      title="More actions"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <ItemMenuContent kind="dropdown" entries={menu} />
                </DropdownMenu>
              </div>
            </div>
          </ContextMenuTrigger>
          <ItemMenuContent kind="context" entries={menu} />
        </ContextMenu>
      )}
    </li>
  );
}
