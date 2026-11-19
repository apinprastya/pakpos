import { useMemo, useRef, useState } from "react";
import {
  BookmarkCheck,
  ChevronLeft,
  Folder,
  FolderTree,
  Globe,
  Layers,
  Play,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DocKindIcon } from "@/features/scopes/DocKindIcon";
import { ConfirmDeleteDialog } from "@/features/sidebar/ConfirmDeleteDialog";
import { statusTextClass } from "@/features/response/format";
import { methodShortLabel, methodTextClass } from "@/lib/http";
import { modKeyLabel } from "@/lib/platform";
import { destinations, findContainer } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useEnvironmentsStore } from "@/stores/environments";
import { useExamplesStore } from "@/stores/examples";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore, type PalettePage } from "@/stores/palette";
import { useSecretsStore } from "@/stores/secrets";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { useRunnerStore } from "@/stores/runner";
import { openRunnerFor } from "@/features/runner/open";
import { runTime } from "@/features/runner/format";
import type { RunListItem } from "@/lib/runModel";
import { availableActions, type ActionContext, type PaletteAction } from "./actions";
import { pushRecent, readRecent } from "./recent";
import { buildItems, fuzzyScore, rankItems, recentItems, type SearchItem } from "./search";

/** The palette (Mod+K) and the confirm its actions may ask for. */
export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const confirm = usePaletteStore((s) => s.confirm);
  const restoreFocus = useRef(true);
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && usePaletteStore.getState().close()}>
        {open && (
          <DialogContent
            showCloseButton={false}
            aria-describedby="command-palette-help"
            className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
            onOpenAutoFocus={() => (restoreFocus.current = true)}
            onEscapeKeyDown={(e) => {
              // Esc on a second step goes back to the actions.
              if (usePaletteStore.getState().page) {
                e.preventDefault();
                usePaletteStore.getState().back();
              }
            }}
            onCloseAutoFocus={(e) => {
              // A reveal is about to focus a tree row: don't send focus back.
              if (!restoreFocus.current) e.preventDefault();
            }}
          >
            <DialogTitle className="sr-only">Command palette</DialogTitle>
            <PaletteBody onFocusElsewhere={() => (restoreFocus.current = false)} />
          </DialogContent>
        )}
      </Dialog>
      <ConfirmDeleteDialog target={confirm} onClose={() => usePaletteStore.getState().setConfirm(null)} />
    </>
  );
}

type Row =
  | { kind: "item"; item: SearchItem }
  | { kind: "action"; action: PaletteAction }
  | { kind: "env"; id: string; name: string }
  | { kind: "dest"; id: string; name: string; path: string; folder: boolean }
  | { kind: "runTarget"; id: string; name: string; path: string; folder: boolean }
  | { kind: "pastRun"; run: RunListItem };

interface Section {
  heading?: string;
  rows: Row[];
}

const rowValue = (r: Row): string => {
  switch (r.kind) {
    case "item":
      return r.item.value;
    case "action":
      return `action:${r.action.id}`;
    case "env":
      return envValue(r.id);
    case "dest":
      return `dest:${r.id}`;
    case "runTarget":
      return `run:${r.id}`;
    case "pastRun":
      return `past-run:${r.run.id}`;
  }
};

/** A past run's label in the palette: "API · 19 Nov, 09:30 · Passed". */
function pastRunLabel(r: RunListItem): string {
  const t = r.totals;
  return `${r.target.name} · ${runTime(r.createdAt)} · ${t.testsPassed} passed, ${t.testsFailed} failed, ${t.errors} errors`;
}

/** cmdk value of an environment step row ("" for "No environment"). */
const envValue = (id: string) => `env-pick:${id}`;

const PAGE_TITLES: Record<PalettePage, string> = {
  environment: "Switch environment",
  move: "Move current request to",
  "run-collection": "Run collection",
  "run-folder": "Run folder",
  "run-history": "Run history",
};

const PLACEHOLDERS = {
  search: "Search requests, folders, environments… (type > for actions)",
  actions: "Run an action…",
  environment: "Choose an environment…",
  move: "Choose a collection or folder…",
  "run-collection": "Choose a collection to run…",
  "run-folder": "Choose a folder to run…",
  "run-history": "Choose a past run…",
};

function PaletteBody({ onFocusElsewhere }: { onFocusElsewhere: () => void }) {
  const input = usePaletteStore((s) => s.input);
  const page = usePaletteStore((s) => s.page);
  const { setInput, back } = usePaletteStore.getState();
  const [selected, setSelected] = useState("");
  // The environment step opens on the environment in use; cmdk would move the
  // highlight to the first row when the list changes, so its automatic picks
  // are ignored until the user moves, types or points.
  const preselect = useRef<string | null>(null);
  const onSelectedChange = (value: string) => {
    if (preselect.current && usePaletteStore.getState().page !== "environment") preselect.current = null;
    const keep = preselect.current;
    if (keep && value !== keep) {
      // cmdk already moved its own highlight; changing the prop puts it back
      // (it trims the value, so a trailing space makes a new prop).
      setSelected((cur) => (cur === keep ? `${keep} ` : keep));
      return;
    }
    setSelected(value);
  };
  const release = () => (preselect.current = null);

  const workspace = useWorkspaceStore((s) => s.workspace);
  const collections = useWorkspaceStore((s) => s.collections);
  const environments = useEnvironmentsStore((s) => s.environments);
  const selectedEnv = useEnvironmentsStore((s) => s.selectedId);
  const byRequest = useExamplesStore((s) => s.byRequest);
  const pastRuns = useRunnerStore((s) => s.past);
  const tabs = useTabsStore((s) => s.tabs);
  const tab = useActiveTab();
  const secrets = useSecretsStore((s) => s.status);
  const wsId = workspace?.id ?? "";
  const [recent, setRecent] = useState(() => readRecent(wsId));

  const items = useMemo(
    () =>
      buildItems({
        collections: workspace ? collections : [],
        environments: workspace ? environments : [],
        hasWorkspace: !!workspace,
        examples: workspace ? Object.values(byRequest).flat() : [],
        tabs,
      }),
    [workspace, collections, environments, byRequest, tabs],
  );

  const close = () => usePaletteStore.getState().close();
  // What `enabled` needs while rendering; `ctx` adds goTo for running.
  const base: ActionContext = {
    tab,
    workspace,
    secrets,
    goTo: () => {},
    confirm: (target) => usePaletteStore.getState().setConfirm(target),
  };
  const ctx: ActionContext = {
    ...base,
    goTo: (p) => {
      if (p === "environment") {
        preselect.current = envValue(useEnvironmentsStore.getState().selectedId);
        setSelected(preselect.current);
      }
      usePaletteStore.getState().goTo(p);
    },
  };
  const remember = (value: string) => setRecent(pushRecent(wsId, value));

  const mode = page ?? (input.startsWith(">") ? "actions" : "search");
  const query = (mode === "actions" ? input.slice(1) : input).trim();

  const sections: Section[] = useMemo(() => {
    if (mode === "environment") {
      const rows: Row[] = [
        { kind: "env", id: "", name: "No environment" },
        ...environments.map((e) => ({ kind: "env" as const, id: e.id, name: e.name })),
      ];
      return [
        { rows: rows.filter((r) => r.kind === "env" && (!query || fuzzyScore(query, r.name) !== null)) },
      ];
    }
    if (mode === "move") {
      const current = tab.parentId;
      const rows = destinations(collections)
        .filter((d) => d.id !== current)
        .map((d): Row => ({
          kind: "dest",
          id: d.id,
          name: d.name,
          path: d.path,
          folder: d.kind === "folder",
        }))
        .map((r) => ({ r, score: query && r.kind === "dest" ? fuzzyScore(query, r.path) : 0 }))
        .filter((x) => x.score !== null)
        .sort((a, b) => (query ? (b.score ?? 0) - (a.score ?? 0) : 0))
        .map((x) => x.r);
      return [{ rows }];
    }
    if (mode === "run-collection" || mode === "run-folder") {
      const kind = mode === "run-collection" ? "collection" : "folder";
      const rows = destinations(collections)
        .filter((d) => d.kind === kind)
        .map((d): Row => ({
          kind: "runTarget",
          id: d.id,
          name: d.name,
          path: d.path,
          folder: d.kind === "folder",
        }))
        .map((r) => ({ r, score: query && r.kind === "runTarget" ? fuzzyScore(query, r.path) : 0 }))
        .filter((x) => x.score !== null)
        .sort((a, b) => (query ? (b.score ?? 0) - (a.score ?? 0) : 0))
        .map((x) => x.r);
      return [{ rows }];
    }
    if (mode === "run-history") {
      const rows = pastRuns
        .filter((r) => !query || fuzzyScore(query, pastRunLabel(r)) !== null)
        .map((run): Row => ({ kind: "pastRun", run }));
      return [{ rows }];
    }
    const actions = availableActions(base);
    if (mode === "actions") {
      if (!query) {
        const groups = new Map<string, Row[]>();
        for (const a of actions)
          groups.set(a.group, [...(groups.get(a.group) ?? []), { kind: "action", action: a }]);
        const recentActions = recent
          .map((v) => actions.find((a) => `action:${a.id}` === v))
          .filter((a): a is PaletteAction => !!a)
          .slice(0, 3)
          .map((a): Row => ({ kind: "action", action: a }));
        const grouped = [...groups].map(([heading, rows]) => ({
          heading,
          rows: rows.filter((r) => !recentActions.some((x) => rowValue(x) === rowValue(r))),
        }));
        return [{ heading: "Recent", rows: recentActions }, ...grouped];
      }
      return [
        {
          heading: "Actions",
          rows: rankActions(actions, query, recent).map((a) => ({ kind: "action", action: a })),
        },
      ];
    }
    // Search mode.
    const savedOpen = new Set(items.filter((i) => i.kind === "request").map((i) => i.id));
    const tabRows = items.filter((i) => i.kind === "tab");
    if (!query) {
      return [
        { heading: "Recent", rows: recentItems(items, recent).map((item) => ({ kind: "item", item })) },
        { heading: "Open tabs", rows: tabRows.map((item) => ({ kind: "item", item })) },
      ];
    }
    // An open tab of a saved request is found as the request itself.
    const searchable = items.filter(
      (i) => i.kind !== "tab" || !savedOpen.has(tabs.find((t) => t.id === i.id)?.saved?.id ?? ""),
    );
    return [
      {
        heading: "Results",
        rows: rankItems(searchable, query, recent).map((item) => ({ kind: "item", item })),
      },
      {
        heading: "Actions",
        rows: rankActions(actions, query, recent)
          .slice(0, 5)
          .map((a) => ({ kind: "action", action: a })),
      },
    ];
    // ctx is rebuilt every render; its inputs are listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, items, recent, environments, collections, tab, workspace, secrets, tabs, pastRuns]);

  const rows = sections.flatMap((s) => s.rows);

  const choose = async (row: Row, alt = false) => {
    const value = rowValue(row);
    const treeVisible = useLayoutStore.getState().sidebarView === "collections";
    if (row.kind === "action") {
      remember(value);
      if (row.action.opensPage) {
        row.action.run(ctx);
        return;
      }
      if (["reveal-request", "new-folder", "new-collection"].includes(row.action.id)) onFocusElsewhere();
      close();
      row.action.run(ctx);
      return;
    }
    close();
    if (row.kind === "env") {
      void useEnvironmentsStore.getState().select(row.id);
      return;
    }
    if (row.kind === "runTarget") {
      openRunnerFor(row.id);
      return;
    }
    if (row.kind === "pastRun") {
      const target = row.run.target.id;
      if (!openRunnerFor(target)) {
        toast.error("Couldn't open the run", {
          description: `Its ${row.run.target.kind} "${row.run.target.name}" no longer exists.`,
        });
        return;
      }
      await useRunnerStore.getState().openPast(target, row.run.id);
      return;
    }
    if (row.kind === "dest") {
      const id = tab.saved?.id;
      if (!id) return;
      const end = findContainer(collections, row.id)?.children.filter((c) => c.id !== id).length ?? 0;
      await useWorkspaceStore.getState().moveRequest(id, row.id, end);
      toast.success("Request moved", { description: row.path });
      return;
    }
    const item = row.item;
    if (item.kind !== "tab") remember(value);
    const ws = useWorkspaceStore.getState();
    switch (item.kind) {
      case "tab":
        useTabsStore.getState().activate(item.id);
        return;
      case "environment":
        if (alt) void useEnvironmentsStore.getState().select(item.id);
        else useEnvironmentsStore.getState().open(item.id);
        return;
      case "globals":
        useEnvironmentsStore.getState().openGlobals();
        return;
      case "folder":
      case "collection":
        if (treeVisible) onFocusElsewhere();
        useTreeStore.getState().revealInTree(item.id);
        return;
      case "request":
        if (treeVisible) onFocusElsewhere();
        await ws.openRequest(item.id);
        useTreeStore.getState().revealInTree(item.id);
        return;
      case "example": {
        const requestId = item.requestId ?? "";
        if (treeVisible) onFocusElsewhere();
        await ws.openRequest(requestId);
        const opened = useTabsStore.getState().tabs.find((t) => t.saved?.id === requestId);
        if (opened) await useExamplesStore.getState().show(opened.id, requestId, item.id);
        useTreeStore.getState().revealInTree(requestId);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    release();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const row = rows.find((r) => rowValue(r) === selected.trim());
      if (row?.kind === "item" && row.item.kind === "environment") void choose(row, true);
      else if (row) void choose(row);
      return;
    }
    if (e.key === "Backspace" && page && input === "") {
      e.preventDefault();
      back();
    }
  };

  const placeholder = page
    ? PLACEHOLDERS[page]
    : mode === "actions"
      ? PLACEHOLDERS.actions
      : PLACEHOLDERS.search;

  return (
    <Command
      shouldFilter={false}
      loop
      value={selected}
      onValueChange={onSelectedChange}
      onKeyDown={onKeyDown}
      label="Command palette"
      className="rounded-none! bg-popover"
    >
      {page && (
        <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            aria-label="Back to actions"
            title="Back (Backspace)"
            onClick={back}
            className="flex size-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronLeft className="size-4" />
          </button>
          <nav aria-label="Palette steps" className="flex items-center gap-1">
            <span>Actions</span>
            <span aria-hidden>›</span>
            <span className="font-medium text-foreground" aria-current="page">
              {PAGE_TITLES[page]}
            </span>
          </nav>
        </div>
      )}
      <CommandInput
        value={input}
        onValueChange={(v) => {
          release();
          setInput(v);
        }}
        placeholder={placeholder}
        aria-label={page ? PAGE_TITLES[page] : "Search or run an action"}
      />
      <CommandList className="max-h-[min(24rem,60vh)]" onPointerMove={release}>
        <CommandEmpty>
          <EmptyCopy mode={mode} query={query} hasWorkspace={!!workspace} />
        </CommandEmpty>
        {sections
          .filter((s) => s.rows.length > 0)
          .map((s, i) => (
            <CommandGroup key={s.heading ?? i} heading={s.heading}>
              {s.rows.map((r) => (
                <CommandItem
                  key={rowValue(r)}
                  value={rowValue(r)}
                  onSelect={() => void choose(r)}
                  // The vendored item appends a check mark; the palette shows "In use" instead.
                  className="[&>svg:last-child]:hidden"
                >
                  <RowContent row={r} selectedEnv={selectedEnv} />
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
      </CommandList>
      <Footer mode={mode} />
    </Command>
  );
}

/** Actions matching `query`, best first; recently used ones break ties. */
function rankActions(actions: PaletteAction[], query: string, recent: string[]): PaletteAction[] {
  const rank = new Map(recent.map((v, i) => [v, i]));
  return actions
    .map((a) => {
      const words = query.split(/\s+/).filter(Boolean);
      let score = 0;
      for (const w of words) {
        const best = Math.max(
          (fuzzyScore(w, a.label) ?? -Infinity) * 1.5,
          ...(a.keywords ?? []).map((k) => fuzzyScore(w, k) ?? -Infinity),
        );
        if (best === -Infinity) return null;
        score += best;
      }
      return { a, score, recent: rank.get(`action:${a.id}`) ?? Infinity };
    })
    .filter((x): x is { a: PaletteAction; score: number; recent: number } => !!x)
    .sort((x, y) => y.score - x.score || x.recent - y.recent)
    .map((x) => x.a);
}

const KIND_LABEL: Record<SearchItem["kind"], string> = {
  request: "Request",
  folder: "Folder",
  collection: "Collection",
  environment: "Environment",
  globals: "Variables",
  example: "Example",
  tab: "Open tab",
};

function KindIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden className="size-4 text-muted-foreground" />;
}

/** Fixed-width slot for a search result's method badge or icon, so names line up. */
function Slot({ children }: { children: React.ReactNode }) {
  return <span className="flex w-8 shrink-0 items-center">{children}</span>;
}

function RowContent({ row, selectedEnv }: { row: Row; selectedEnv: string }) {
  if (row.kind === "action") {
    return (
      <>
        <KindIcon icon={Zap} />
        <span className="min-w-0 flex-1 truncate">{row.action.label}</span>
        {row.action.shortcut && <CommandShortcut>{row.action.shortcut()}</CommandShortcut>}
      </>
    );
  }
  if (row.kind === "env") {
    return (
      <>
        <KindIcon icon={Layers} />
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        {row.id === selectedEnv && <span className="text-xs text-muted-foreground">In use</span>}
      </>
    );
  }
  if (row.kind === "pastRun") {
    return (
      <>
        <KindIcon icon={Play} />
        <span className="min-w-0 flex-1 truncate">{pastRunLabel(row.run)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {row.run.environmentName || "No environment"}
        </span>
      </>
    );
  }
  if (row.kind === "dest" || row.kind === "runTarget") {
    return (
      <>
        <KindIcon icon={row.folder ? Folder : FolderTree} />
        <span className="min-w-0 truncate">{row.name}</span>
        {row.path !== row.name && (
          <span className="ml-auto min-w-0 truncate pl-3 text-xs text-muted-foreground">{row.path}</span>
        )}
      </>
    );
  }
  const { item } = row;
  const side = item.kind === "request" || item.kind === "example" ? item.path : KIND_LABEL[item.kind];
  return (
    <>
      <Slot>
        <ItemIcon item={item} />
      </Slot>
      <span className="min-w-0 truncate">{item.label}</span>
      {item.kind === "environment" && item.id === selectedEnv && (
        <span className="shrink-0 text-xs text-muted-foreground">In use</span>
      )}
      {side && (
        <span className="ml-auto min-w-0 shrink truncate pl-3 text-xs text-muted-foreground">{side}</span>
      )}
    </>
  );
}

function ItemIcon({ item }: { item: SearchItem }) {
  if (item.kind === "request" || (item.kind === "tab" && item.method)) {
    return (
      <span className={cn("font-mono text-[10px] font-semibold", methodTextClass(item.method ?? "GET"))}>
        {methodShortLabel(item.method ?? "GET")}
      </span>
    );
  }
  switch (item.kind) {
    case "folder":
      return <KindIcon icon={Folder} />;
    case "collection":
      return <KindIcon icon={FolderTree} />;
    case "environment":
      return <KindIcon icon={Layers} />;
    case "globals":
      return <KindIcon icon={Globe} />;
    case "example":
      return <ExampleIcon />;
    default:
      return <TabDocIcon id={item.id} />;
  }
}

function ExampleIcon() {
  return <BookmarkCheck aria-hidden className={cn("size-4", statusTextClass(200))} />;
}

function TabDocIcon({ id }: { id: string }) {
  const kind = useTabsStore((s) => s.tabs.find((t) => t.id === id)?.doc?.kind);
  return kind ? <DocKindIcon kind={kind} className="size-4" /> : <KindIcon icon={Layers} />;
}

function EmptyCopy({ mode, query, hasWorkspace }: { mode: string; query: string; hasWorkspace: boolean }) {
  switch (mode) {
    case "actions":
      return <>No actions match &ldquo;{query}&rdquo;. Try another word, or clear the &gt; to search.</>;
    case "environment":
      return <>No environments match &ldquo;{query}&rdquo;.</>;
    case "move":
      return query ? (
        <>No collections or folders match &ldquo;{query}&rdquo;.</>
      ) : (
        <>There&apos;s nowhere else to move it. Create a collection or folder first.</>
      );
    case "run-collection":
    case "run-folder":
      return <>Nothing matches &ldquo;{query}&rdquo;.</>;
    case "run-history":
      return query ? (
        <>No past runs match &ldquo;{query}&rdquo;.</>
      ) : (
        <>No past runs yet. Run a collection or folder first.</>
      );
    default:
      if (!query)
        return <>Type to search requests, folders, collections and environments. Type &gt; for actions.</>;
      return hasWorkspace ? (
        <>Nothing matches &ldquo;{query}&rdquo;. Search by name, folder or URL, or type &gt; for actions.</>
      ) : (
        <>
          No open tabs match &ldquo;{query}&rdquo;. Open a workspace to search its requests, or type &gt; for
          actions.
        </>
      );
  }
}

function Footer({ mode }: { mode: string }) {
  const mod = modKeyLabel();
  return (
    <p
      id="command-palette-help"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <span>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> move
      </span>
      <span>
        <Kbd>Enter</Kbd> {mode === "search" ? "open" : "run"}
      </span>
      {mode === "search" && (
        <span>
          <Kbd>{mod}+Enter</Kbd> use environment
        </span>
      )}
      {mode === "search" && (
        <span>
          <Kbd>&gt;</Kbd> actions
        </span>
      )}
      {mode !== "search" && mode !== "actions" && (
        <span>
          <Kbd>Backspace</Kbd> back
        </span>
      )}
      <span className="ml-auto">
        <Kbd>Esc</Kbd> {mode !== "search" && mode !== "actions" ? "back" : "close"}
      </span>
    </p>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-0.5 rounded border bg-muted px-1 py-px font-mono text-[10px] text-foreground">
      {children}
    </kbd>
  );
}
