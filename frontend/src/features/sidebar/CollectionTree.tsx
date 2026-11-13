import { useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { plural } from "@/lib/errors";
import { methodShortLabel, methodTextClass } from "@/lib/http";
import type { CollectionNode, RequestSummary } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import type { DeleteTarget } from "./ConfirmDeleteDialog";
import { InlineRename } from "./InlineRename";
import { ItemMenuContent, type MenuEntry } from "./ItemMenu";
import {
  colKey,
  findCollectionOf,
  isColKey,
  keyId,
  moveRequestOver,
  positionOf,
  reorder,
  reqKey,
  visibleItems,
} from "./treeModel";

interface CollectionTreeProps {
  collections: CollectionNode[];
  /** Filter is active: everything is expanded and reordering is off. */
  filtering: boolean;
  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
  confirmDelete: (target: DeleteTarget) => void;
}

/** Collections and their requests as an accessible, sortable tree. */
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
  const [preview, setPreview] = useState<CollectionNode[] | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  const shown = preview ?? collections;
  const expanded = (id: string) => filtering || isExpanded(id);
  const items = visibleItems(shown, expanded);
  const current = items.some((i) => i.key === focusKey) ? focusKey : (items[0]?.key ?? null);

  // A just-created item starts in rename mode.
  const targetKey = useMemo(() => {
    if (!renameTarget) return null;
    if (shown.some((c) => c.id === renameTarget)) return colKey(renameTarget);
    if (findCollectionOf(shown, renameTarget)) return reqKey(renameTarget);
    return null;
  }, [renameTarget, shown]);
  const renamingKey = renaming ?? targetKey;

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    rows.current.get(key)?.focus();
  };
  const endRename = () => {
    setRenaming(null);
    if (renameTarget) store().setRenameTarget(null);
  };

  /* ---------- actions ---------- */

  const deleteCollection = (c: CollectionNode) =>
    confirmDelete({
      title: `Delete collection "${c.name}"?`,
      description:
        c.requests.length > 0
          ? `This deletes the collection and ${plural(c.requests.length, "request")} in it from the workspace folder.`
          : "This deletes the empty collection from the workspace folder.",
      confirmLabel: "Delete collection",
      onConfirm: () => void store().deleteCollection(c.id),
    });

  const deleteRequest = (r: RequestSummary) =>
    confirmDelete({
      title: `Delete request "${r.name}"?`,
      description: "This deletes the request's file from the workspace folder.",
      confirmLabel: "Delete request",
      onConfirm: () => void store().deleteRequest(r.id),
    });

  const newRequest = (c: CollectionNode) => {
    setExpanded(c.id, true);
    void store().newRequest(c.id);
  };

  const collectionMenu = (c: CollectionNode): MenuEntry[] => [
    { label: "New request", icon: FilePlus, onSelect: () => newRequest(c) },
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(colKey(c.id)) },
    "separator",
    {
      label: "Delete",
      icon: Trash2,
      destructive: true,
      shortcut: "Del",
      onSelect: () => deleteCollection(c),
    },
  ];

  const requestMenu = (r: RequestSummary, c: CollectionNode): MenuEntry[] => [
    { label: "Open", icon: ExternalLink, onSelect: () => void store().openRequest(r.id) },
    { label: "Rename", icon: Pencil, shortcut: "F2", onSelect: () => setRenaming(reqKey(r.id)) },
    { label: "Duplicate", icon: Copy, onSelect: () => void store().duplicateRequest(r.id) },
    {
      label: "Move to",
      icon: FolderInput,
      empty: "No other collections",
      submenu: allCollections
        .filter((o) => o.id !== c.id)
        .map((o) => ({
          label: o.name,
          onSelect: () => void store().moveRequest(r.id, o.id, o.requests.length),
        })),
    },
    "separator",
    { label: "Delete", icon: Trash2, destructive: true, shortcut: "Del", onSelect: () => deleteRequest(r) },
  ];

  /* ---------- keyboard ---------- */

  const lookup = (key: string) => {
    if (isColKey(key)) {
      const c = shown.find((x) => x.id === keyId(key));
      return c ? { collection: c } : null;
    }
    const c = findCollectionOf(shown, keyId(key));
    const r = c?.requests.find((x) => x.id === keyId(key));
    return c && r ? { collection: c, request: r } : null;
  };

  const moveByKeyboard = (key: string, delta: -1 | 1) => {
    const found = lookup(key);
    if (!found || filtering) return;
    if (!found.request) {
      const ids = shown.map((c) => c.id);
      const from = ids.indexOf(found.collection.id);
      const to = from + delta;
      if (to < 0 || to >= ids.length) return;
      void store().reorderCollections(reorder(ids, ids[from], ids[to]));
      return;
    }
    const idx = found.collection.requests.findIndex((r) => r.id === found.request.id);
    const to = idx + delta;
    if (to < 0 || to >= found.collection.requests.length) return;
    void store().moveRequest(found.request.id, found.collection.id, to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!current || renamingKey) return;
    const idx = items.findIndex((i) => i.key === current);
    const item = items[idx];
    const found = lookup(current);
    if (!found) return;
    const isCol = !found.request;

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveByKeyboard(current, e.key === "ArrowUp" ? -1 : 1);
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
        if (isCol) {
          if (!expanded(found.collection.id)) setExpanded(found.collection.id, true);
          else if (items[idx + 1]?.parent === current) focusRow(items[idx + 1].key);
        }
        break;
      case "ArrowLeft":
        if (isCol) {
          if (expanded(found.collection.id) && !filtering) setExpanded(found.collection.id, false);
        } else focusRow(item.parent);
        break;
      case "Enter":
        if (isCol) setExpanded(found.collection.id, !expanded(found.collection.id));
        else void store().openRequest(found.request.id);
        break;
      case "F2":
        setRenaming(current);
        break;
      case "Delete":
        if (isCol) deleteCollection(found.collection);
        else deleteRequest(found.request);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /* ---------- drag and drop ---------- */

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const collision: CollisionDetection = (args) => {
    const activeIsCol = isColKey(String(args.active.id));
    const cols = args.droppableContainers.filter((c) => isColKey(String(c.id)));
    if (activeIsCol) return closestCenter({ ...args, droppableContainers: cols });
    const reqs = args.droppableContainers.filter((c) => !isColKey(String(c.id)));
    const overRequest = pointerWithin({ ...args, droppableContainers: reqs });
    if (overRequest.length) return overRequest;
    const overCollection = pointerWithin({ ...args, droppableContainers: cols });
    if (overCollection.length) return overCollection;
    return closestCenter({ ...args, droppableContainers: reqs });
  };

  const onDragStart = (e: DragStartEvent) => {
    setPreview(collections);
    setFocusKey(String(e.active.id));
  };

  const onDragOver = (e: DragOverEvent) => {
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over || isColKey(active) || !preview) return;
    const from = findCollectionOf(preview, keyId(active));
    const to = isColKey(over)
      ? preview.find((c) => c.id === keyId(over))
      : findCollectionOf(preview, keyId(over));
    if (from && to && from.id !== to.id) setPreview(moveRequestOver(preview, keyId(active), over));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    const base = preview ?? collections;
    setPreview(null);
    if (!over) return;
    if (isColKey(active)) {
      if (!isColKey(over) || over === active) return;
      const ids = collections.map((c) => c.id);
      void store().reorderCollections(reorder(ids, keyId(active), keyId(over)));
      return;
    }
    const final = over === active ? base : moveRequestOver(base, keyId(active), over);
    const pos = positionOf(final, keyId(active));
    if (pos) void store().moveRequest(keyId(active), pos.collectionId, pos.index);
  };

  /* ---------- render ---------- */

  const rowRef = (key: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, el);
    else rows.current.delete(key);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setPreview(null)}
    >
      <SortableContext items={shown.map((c) => colKey(c.id))} strategy={verticalListSortingStrategy}>
        <ul role="tree" aria-label="Collections" onKeyDown={onKeyDown} className="flex flex-col py-1">
          {shown.map((c) => {
            const key = colKey(c.id);
            const open = expanded(c.id);
            return (
              <SortableItem key={key} id={key} disabled={filtering || !!renamingKey}>
                {({ setNodeRef, style, listeners, isDragging }) => (
                  <li
                    ref={(el) => {
                      setNodeRef(el);
                      rowRef(key)(el);
                    }}
                    style={style}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={open}
                    aria-label={c.name}
                    tabIndex={current === key ? 0 : -1}
                    onFocus={(e) => e.target === e.currentTarget && setFocusKey(key)}
                    className={cn("group/col outline-none", isDragging && "relative z-10 opacity-80")}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          {...listeners}
                          onClick={() => {
                            focusRow(key);
                            setExpanded(c.id, !open);
                          }}
                          className="group/row mx-1 flex h-7 cursor-default items-center gap-1 rounded-md pr-1 pl-1 group-focus-visible/col:ring-2 group-focus-visible/col:ring-ring group-focus-visible/col:ring-inset hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
                        >
                          <ChevronRight
                            aria-hidden
                            className={cn(
                              "size-3.5 shrink-0 text-muted-foreground transition-transform",
                              open && "rotate-90",
                            )}
                          />
                          {renamingKey === key ? (
                            <InlineRename
                              initial={c.name}
                              label="Collection name"
                              onCommit={(name) => {
                                endRename();
                                void store().renameCollection(c.id, name);
                                focusRow(key);
                              }}
                              onCancel={() => {
                                endRename();
                                focusRow(key);
                              }}
                            />
                          ) : (
                            <>
                              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                              <span className="text-[11px] text-muted-foreground tabular-nums group-hover/row:hidden">
                                {c.requests.length || ""}
                              </span>
                              <MoreButton label={`More actions for ${c.name}`} entries={collectionMenu(c)} />
                            </>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ItemMenuContent kind="context" entries={collectionMenu(c)} />
                    </ContextMenu>

                    {open && (
                      <SortableContext
                        items={c.requests.map((r) => reqKey(r.id))}
                        strategy={verticalListSortingStrategy}
                      >
                        <ul role="group" className="flex flex-col">
                          {c.requests.length === 0 && (
                            <li role="none" className="py-1 pr-2 pl-8 text-xs text-muted-foreground">
                              No requests yet
                            </li>
                          )}
                          {c.requests.map((r) => {
                            const rk = reqKey(r.id);
                            const active = r.id === activeRequestId;
                            return (
                              <SortableItem key={rk} id={rk} disabled={filtering || !!renamingKey}>
                                {(s) => (
                                  <li
                                    ref={(el) => {
                                      s.setNodeRef(el);
                                      rowRef(rk)(el);
                                    }}
                                    style={s.style}
                                    role="treeitem"
                                    aria-level={2}
                                    aria-selected={active}
                                    aria-label={`${r.method} ${r.name}`}
                                    tabIndex={current === rk ? 0 : -1}
                                    onFocus={(e) => e.target === e.currentTarget && setFocusKey(rk)}
                                    className={cn("group/req outline-none", s.isDragging && "relative z-10")}
                                  >
                                    <ContextMenu>
                                      <ContextMenuTrigger asChild>
                                        <div
                                          {...s.listeners}
                                          onClick={() => {
                                            focusRow(rk);
                                            void store().openRequest(r.id);
                                          }}
                                          title={r.url || undefined}
                                          className={cn(
                                            "group/row mx-1 flex h-7 cursor-default items-center gap-2 rounded-md pr-1 pl-6 group-focus-visible/req:ring-2 group-focus-visible/req:ring-ring group-focus-visible/req:ring-inset hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
                                            active && "bg-sidebar-accent text-sidebar-accent-foreground",
                                            s.isDragging && "bg-background shadow-sm",
                                          )}
                                        >
                                          <span
                                            className={cn(
                                              "w-8 shrink-0 font-mono text-[10px] font-semibold",
                                              methodTextClass(r.method),
                                            )}
                                          >
                                            {methodShortLabel(r.method)}
                                          </span>
                                          {renamingKey === rk ? (
                                            <InlineRename
                                              initial={r.name}
                                              label="Request name"
                                              onCommit={(name) => {
                                                endRename();
                                                void store().renameRequest(r.id, name);
                                                focusRow(rk);
                                              }}
                                              onCancel={() => {
                                                endRename();
                                                focusRow(rk);
                                              }}
                                            />
                                          ) : (
                                            <>
                                              <span className="min-w-0 flex-1 truncate">{r.name}</span>
                                              <MoreButton
                                                label={`More actions for ${r.name}`}
                                                entries={requestMenu(r, c)}
                                              />
                                            </>
                                          )}
                                        </div>
                                      </ContextMenuTrigger>
                                      <ItemMenuContent kind="context" entries={requestMenu(r, c)} />
                                    </ContextMenu>
                                  </li>
                                )}
                              </SortableItem>
                            );
                          })}
                        </ul>
                      </SortableContext>
                    )}
                  </li>
                )}
              </SortableItem>
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

interface SortableRender {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  listeners: ReturnType<typeof useSortable>["listeners"];
  isDragging: boolean;
}

/** useSortable as a render prop, so rows keep their own roles instead of dnd-kit's button attributes. */
function SortableItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (s: SortableRender) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({ id, disabled });
  return children({
    setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition },
    listeners,
    isDragging,
  });
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
