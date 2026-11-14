import { useCallback, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Settings2,
} from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { plural } from "@/lib/errors";
import { methodShortLabel, methodTextClass } from "@/lib/http";
import type { CollectionNode, ContainerNode, RequestSummary, TreeChild, TreeNode } from "@/lib/model";
import { countRequests, destinations, findContainer, findNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { openContainerSettings } from "@/features/scopes/docActions";
import type { DeleteTarget } from "./ConfirmDeleteDialog";
import { InlineRename } from "./InlineRename";
import { ItemMenuContent, type MenuEntry, type SubmenuItem } from "./ItemMenu";
import {
  collectionOrder,
  dropPosition,
  dropTarget,
  isColKey,
  keyId,
  keyKind,
  nodeKey,
  subtreeKeys,
  visibleItems,
  type DropPosition,
  type DropTarget,
  type VisibleItem,
} from "./treeModel";

interface CollectionTreeProps {
  collections: CollectionNode[];
  /** Filter is active: everything is expanded and reordering is off. */
  filtering: boolean;
  /** Expansion by tree key (`c:…` collections, `f:…` folders). */
  isExpanded: (key: string) => boolean;
  setExpanded: (key: string, expanded: boolean) => void;
  confirmDelete: (target: DeleteTarget) => void;
}

/** Indentation per tree level, in pixels. */
const INDENT = 14;

type Indicator = { key: string; position: DropPosition };
type Drop =
  | { kind: "collections"; ids: string[]; indicator: Indicator }
  | { kind: "move"; node: TreeChild; target: DropTarget; indicator: Indicator };

/** Pointer position during a drag: where it went down plus how far it moved. */
function pointerY(e: { activatorEvent: Event | null; delta: { y: number } }): number | null {
  const start = e.activatorEvent as MouseEvent | null;
  return typeof start?.clientY === "number" ? start.clientY + e.delta.y : null;
}

const nameLabel = { collection: "Collection name", folder: "Folder name", request: "Request name" } as const;

/** Collections, folders and requests as an accessible tree with drag and drop across levels. */
export function CollectionTree({
  collections,
  filtering,
  isExpanded,
  setExpanded,
  confirmDelete,
}: CollectionTreeProps) {
  const store = useWorkspaceStore.getState;
  const allCollections = useWorkspaceStore((s) => s.collections);
  const renameTarget = useWorkspaceStore((s) => s.renameTarget);
  const activeRequestId = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId)?.saved?.id ?? "");

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; node: TreeNode; blocked: Set<string> } | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  const expanded = (key: string) => filtering || isExpanded(key);
  const items = visibleItems(collections, expanded);
  const current = items.some((i) => i.key === focusKey) ? focusKey : (items[0]?.key ?? null);

  // A just-created item starts in rename mode.
  const targetKey = useMemo(() => {
    const node = renameTarget ? findNode(collections, renameTarget) : undefined;
    return node ? nodeKey(node) : null;
  }, [renameTarget, collections]);
  const renamingKey = renaming ?? targetKey;

  const focusRow = (key: string | null | undefined) => {
    if (!key) return;
    setFocusKey(key);
    rows.current.get(key)?.focus();
  };
  const endRename = () => {
    setRenaming(null);
    if (renameTarget) store().setRenameTarget(null);
  };

  /* ---------- actions ---------- */

  const deleteNode = (node: TreeNode) => {
    if (node.kind === "request") {
      confirmDelete({
        title: `Delete request "${node.name}"?`,
        description: "This deletes the request's file from the workspace folder.",
        confirmLabel: "Delete request",
        onConfirm: () => void store().deleteRequest(node.id),
      });
      return;
    }
    const what = node.kind === "collection" ? "collection" : "folder";
    const n = countRequests(node);
    confirmDelete({
      title: `Delete ${what} "${node.name}"?`,
      description:
        node.children.length > 0
          ? `This deletes the ${what} and ${plural(n, "request")} in it from the workspace folder.`
          : `This deletes the empty ${what} from the workspace folder.`,
      confirmLabel: `Delete ${what}`,
      onConfirm: () =>
        void (node.kind === "collection" ? store().deleteCollection(node.id) : store().deleteFolder(node.id)),
    });
  };

  const newRequest = (c: ContainerNode) => {
    setExpanded(nodeKey(c), true);
    void store().newRequest(c.id);
  };
  const newFolder = (c: ContainerNode) => {
    setExpanded(nodeKey(c), true);
    void store().createFolder(c.id);
  };

  const move = (node: TreeChild, parentId: string, index: number) =>
    void (node.kind === "folder"
      ? store().moveFolder(node.id, parentId, index)
      : store().moveRequest(node.id, parentId, index));

  /** "Move to" destinations: every collection and folder, nested; a folder can't go inside itself. */
  const moveMenu = (node: TreeChild): SubmenuItem[] =>
    destinations(allCollections, node.kind === "folder" ? node.id : undefined).map((d) => ({
      label: d.name,
      ariaLabel: d.path,
      depth: d.depth,
      icon: d.kind === "folder" ? Folder : undefined,
      disabled: d.id === node.parentId,
      onSelect: () => {
        const target = findContainer(allCollections, d.id);
        const end = target ? target.children.filter((c) => c.id !== node.id).length : 0;
        move(node, d.id, end);
      },
    }));

  const containerMenu = (c: ContainerNode): MenuEntry[] => [
    { label: "New request", icon: FilePlus, onSelect: () => newRequest(c) },
    { label: "New folder", icon: FolderPlus, onSelect: () => newFolder(c) },
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(nodeKey(c)) },
    ...(c.kind === "folder"
      ? [{ label: "Move to", icon: FolderInput, empty: "No collections", submenu: moveMenu(c) }]
      : []),
    { label: "Settings", icon: Settings2, onSelect: () => openContainerSettings(c.id) },
    "separator",
    { label: "Delete", icon: Trash2, destructive: true, shortcut: "Del", onSelect: () => deleteNode(c) },
  ];

  const requestMenu = (r: RequestSummary): MenuEntry[] => [
    { label: "Open", icon: ExternalLink, onSelect: () => void store().openRequest(r.id) },
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(nodeKey(r)) },
    { label: "Duplicate", icon: Copy, onSelect: () => void store().duplicateRequest(r.id) },
    { label: "Move to", icon: FolderInput, empty: "No collections", submenu: moveMenu(r) },
    "separator",
    { label: "Delete", icon: Trash2, destructive: true, shortcut: "Del", onSelect: () => deleteNode(r) },
  ];

  const commitRename = (node: TreeNode, name: string) => {
    if (node.kind === "collection") void store().renameCollection(node.id, name);
    else if (node.kind === "folder") void store().renameFolder(node.id, name);
    else void store().renameRequest(node.id, name);
  };

  /* ---------- keyboard ---------- */

  /** Alt+↑/↓: moves the item one place within its parent. */
  const moveByKeyboard = (node: TreeNode, delta: -1 | 1) => {
    if (filtering) return;
    if (node.kind === "collection") {
      const ids = allCollections.map((c) => c.id);
      const from = ids.indexOf(node.id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return;
      ids.splice(from, 1);
      ids.splice(to, 0, node.id);
      void store().reorderCollections(ids);
      return;
    }
    const siblings = findContainer(allCollections, node.parentId)?.children ?? [];
    const from = siblings.findIndex((c) => c.kind === node.kind && c.id === node.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    move(node, node.parentId, to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!current || renamingKey) return;
    const idx = items.findIndex((i) => i.key === current);
    const item = items[idx];
    if (!item) return;
    const node = item.node;
    const isContainer = node.kind !== "request";

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveByKeyboard(node, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        focusRow(items[idx + 1]?.key);
        break;
      case "ArrowUp":
        focusRow(items[idx - 1]?.key);
        break;
      case "Home":
        focusRow(items[0]?.key);
        break;
      case "End":
        focusRow(items[items.length - 1]?.key);
        break;
      case "ArrowRight":
        if (isContainer) {
          if (!expanded(item.key)) setExpanded(item.key, true);
          else if (items[idx + 1]?.parent === item.key) focusRow(items[idx + 1].key);
        }
        break;
      case "ArrowLeft":
        if (isContainer && expanded(item.key) && !filtering) setExpanded(item.key, false);
        else focusRow(item.parent);
        break;
      case "Enter":
        if (isContainer) setExpanded(item.key, !expanded(item.key));
        else void store().openRequest(node.id);
        break;
      case "F2":
        setRenaming(current);
        break;
      case "Delete":
        deleteNode(node);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /* ---------- drag and drop ---------- */

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Collections only reorder among collections; folders and requests can go
  // anywhere except into the dragged folder's own subtree.
  const collision: CollisionDetection = (args) => {
    const active = String(args.active.id);
    if (isColKey(active)) {
      const cols = args.droppableContainers.filter((c) => isColKey(String(c.id)));
      return closestCenter({ ...args, droppableContainers: cols });
    }
    const blocked = drag?.blocked ?? new Set([active]);
    const allowed = args.droppableContainers.filter((c) => !blocked.has(String(c.id)));
    const under = pointerWithin({ ...args, droppableContainers: allowed });
    return under.length ? under : closestCenter({ ...args, droppableContainers: allowed });
  };

  const resolveDrop = (e: DragMoveEvent | DragEndEvent): Drop | null => {
    const active = String(e.active.id);
    if (!e.over) return null;
    const over = String(e.over.id);
    const position = dropPosition(keyKind(active), keyKind(over), pointerY(e), e.over.rect);
    const ind = { key: over, position };
    if (isColKey(active)) {
      const ids = collectionOrder(collections, active, over, position);
      return ids ? { kind: "collections", ids, indicator: ind } : null;
    }
    const node = findNode(collections, keyId(active), keyKind(active));
    const target = dropTarget(collections, active, over, position);
    return node && node.kind !== "collection" && target
      ? { kind: "move", node, target, indicator: ind }
      : null;
  };

  const onDragStart = (e: DragStartEvent) => {
    const key = String(e.active.id);
    const node = findNode(collections, keyId(key), keyKind(key));
    if (!node) return;
    setDrag({ key, node, blocked: subtreeKeys(node) });
    setFocusKey(key);
  };

  const onDragMove = (e: DragMoveEvent) => {
    const next = resolveDrop(e)?.indicator ?? null;
    setIndicator((prev) => (prev?.key === next?.key && prev?.position === next?.position ? prev : next));
  };

  const endDrag = () => {
    setDrag(null);
    setIndicator(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const drop = resolveDrop(e);
    endDrag();
    if (!drop) return;
    if (drop.kind === "collections") {
      void store().reorderCollections(drop.ids);
      return;
    }
    if (drop.indicator.position === "inside") setExpanded(drop.indicator.key, true);
    move(drop.node, drop.target.parentId, drop.target.index);
  };

  /* ---------- render ---------- */

  const rowRef = (key: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, el);
    else rows.current.delete(key);
  };

  const renderRow = (item: VisibleItem) => {
    const { key, node, level } = item;
    const isContainer = node.kind !== "request";
    const open = isContainer && expanded(key);
    const isActive = node.kind === "request" && node.id === activeRequestId;
    const menu = node.kind === "request" ? requestMenu(node) : containerMenu(node);
    const ind = indicator?.key === key ? indicator.position : null;
    const pad = 4 + (level - 1) * INDENT + (isContainer ? 0 : 6);
    const label = node.kind === "request" ? `${node.method} ${node.name}` : node.name;

    return (
      <DndItem key={key} id={key} disabled={filtering || !!renamingKey}>
        {(d) => (
          <li
            ref={rowRef(key)}
            role="treeitem"
            aria-level={level}
            aria-setsize={item.setSize}
            aria-posinset={item.posInSet}
            aria-expanded={isContainer ? open : undefined}
            aria-selected={node.kind === "request" ? isActive : undefined}
            aria-label={label}
            tabIndex={current === key ? 0 : -1}
            onFocus={(e) => e.target === e.currentTarget && setFocusKey(key)}
            className={cn("group/item outline-none", d.isDragging && "opacity-50")}
          >
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  ref={d.setNodeRef}
                  {...d.listeners}
                  onClick={() => {
                    focusRow(key);
                    if (isContainer) setExpanded(key, !open);
                    else void store().openRequest(node.id);
                  }}
                  title={node.kind === "request" ? node.url || undefined : undefined}
                  data-drop={ind ?? undefined}
                  style={{ paddingLeft: pad }}
                  className={cn(
                    "group/row relative mx-1 flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1 group-focus-visible/item:ring-2 group-focus-visible/item:ring-ring group-focus-visible/item:ring-inset hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
                    isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
                    ind === "inside" && "bg-sidebar-accent ring-1 ring-primary ring-inset",
                  )}
                >
                  {(ind === "before" || ind === "after") && (
                    <span
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
                        ind === "before" ? "-top-px" : "-bottom-px",
                      )}
                    />
                  )}
                  {isContainer ? (
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90",
                      )}
                    />
                  ) : (
                    <span
                      className={cn(
                        "w-8 shrink-0 font-mono text-[10px] font-semibold",
                        methodTextClass(node.method),
                      )}
                    >
                      {methodShortLabel(node.method)}
                    </span>
                  )}
                  {node.kind === "folder" &&
                    (open ? (
                      <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    ))}
                  {renamingKey === key ? (
                    <InlineRename
                      initial={node.name}
                      label={nameLabel[node.kind]}
                      onCommit={(name) => {
                        endRename();
                        commitRename(node, name);
                        focusRow(key);
                      }}
                      onCancel={() => {
                        endRename();
                        focusRow(key);
                      }}
                    />
                  ) : (
                    <>
                      <span
                        className={cn("min-w-0 flex-1 truncate", node.kind === "collection" && "font-medium")}
                      >
                        {node.name}
                      </span>
                      {isContainer && (
                        <span className="text-[11px] text-muted-foreground tabular-nums group-hover/row:hidden">
                          {countRequests(node) || ""}
                        </span>
                      )}
                      <MoreButton label={`More actions for ${node.name}`} entries={menu} />
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ItemMenuContent kind="context" entries={menu} />
            </ContextMenu>
            {open && node.children.length === 0 && (
              <div
                style={{ paddingLeft: 4 + level * INDENT + 10 }}
                className="mx-1 py-1 pr-2 text-xs text-muted-foreground"
              >
                {node.kind === "collection" ? "No requests yet" : "Empty folder"}
              </div>
            )}
          </li>
        )}
      </DndItem>
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={endDrag}
    >
      <ul role="tree" aria-label="Collections" onKeyDown={onKeyDown} className="flex flex-col py-1">
        {items.map(renderRow)}
      </ul>
      <DragOverlay dropAnimation={null}>
        {drag && (
          <div className="flex h-7 max-w-60 items-center gap-1.5 rounded-md border bg-background px-2 text-sm shadow-sm">
            {drag.node.kind === "folder" && <Folder aria-hidden className="size-3.5 text-muted-foreground" />}
            {drag.node.kind === "request" && (
              <span className={cn("font-mono text-[10px] font-semibold", methodTextClass(drag.node.method))}>
                {methodShortLabel(drag.node.method)}
              </span>
            )}
            <span className="truncate">{drag.node.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

interface DndRender {
  setNodeRef: (el: HTMLElement | null) => void;
  listeners: ReturnType<typeof useDraggable>["listeners"];
  isDragging: boolean;
}

/**
 * A row that can be dragged and dropped onto, as a render prop, so rows keep
 * their own tree roles instead of dnd-kit's button attributes.
 */
function DndItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (d: DndRender) => React.ReactNode;
}) {
  const drag = useDraggable({ id, disabled });
  const drop = useDroppable({ id, disabled });
  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );
  return children({ setNodeRef, listeners: drag.listeners, isDragging: drag.isDragging });
}

/** Hover button with the same actions as the right-click menu. */
function MoreButton({ label, entries }: { label: string; entries: MenuEntry[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title="More actions"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground group-hover/row:flex hover:bg-background hover:text-foreground data-[state=open]:flex"
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <ItemMenuContent kind="dropdown" entries={entries} />
    </DropdownMenu>
  );
}
