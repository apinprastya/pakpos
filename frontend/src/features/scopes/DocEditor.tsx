import { useEffect, useMemo, useState } from "react";
import { Check, Copy, MoreHorizontal, Pencil, Save, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AuthEditor } from "@/features/request/AuthEditor";
import { SUGGESTED_NAMES, type SecretField } from "@/features/request/auth";
import { InheritedAuth } from "@/features/request/Inherited";
import { KeyValueTable } from "@/features/request/KeyValueTable";
import { usePreview } from "@/features/request/usePreview";
import { ConfirmDeleteDialog, type DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import { InlineRename } from "@/features/sidebar/InlineRename";
import { ItemMenuContent, type MenuEntry } from "@/features/sidebar/ItemMenu";
import { errorMessage } from "@/lib/errors";
import { emptyRequest, type Variable } from "@/lib/model";
import { modKeyLabel } from "@/lib/platform";
import { collectionIdOf, positionOf } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { isDirty, tabTitle, useTabsStore, type DocKind, type DocState, type Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { docScope, loadDocTab, saveDocTab } from "./docActions";
import { MoveToSecretDialog } from "./MoveToSecretDialog";
import { DocKindIcon } from "./DocKindIcon";
import { VariablesTable } from "./VariablesTable";

const KIND_LABELS: Record<DocKind, string> = {
  environment: "Environment",
  globals: "Global variables",
  collection: "Collection settings",
  folder: "Folder settings",
};

/**
 * The body of an environment, globals, collection or folder settings tab:
 * loads on first show, then edits a draft that's saved with Save or Mod+S.
 */
export function DocEditor({ tab }: { tab: Tab }) {
  const doc = tab.doc!;
  const [failure, setFailure] = useState<{ attempt: number; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = doc.draft !== null && doc.saved !== null;
  // An error belongs to one attempt; "Try again" starts a new one.
  const loadError = failure?.attempt === attempt ? failure.message : null;

  useEffect(() => {
    if (loaded) return;
    let live = true;
    loadDocTab(tab.id).catch((e: unknown) => live && setFailure({ attempt, message: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [tab.id, loaded, attempt]);

  const title = tabTitle(tab);
  let body: React.ReactNode;
  if (loadError) {
    body = (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <TriangleAlert aria-hidden className="size-5 text-destructive" />
        <p className="font-semibold">Couldn&apos;t load {title}</p>
        <p className="selectable max-w-md text-xs break-words text-muted-foreground">{loadError}</p>
        <p className="max-w-md text-xs text-muted-foreground">
          It may have been deleted or its file may be invalid. Fix the file, then try again.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => useTabsStore.getState().close(tab.id)}>
            Close tab
          </Button>
        </div>
      </div>
    );
  } else if (!loaded) {
    body = (
      <p role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading {title}…
      </p>
    );
  } else if (doc.kind === "environment" || doc.kind === "globals") {
    body = <VariablesBody tab={tab} doc={doc} />;
  } else {
    body = <ContainerBody tab={tab} doc={doc} />;
  }

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <DocHeader tab={tab} doc={doc} canSave={loaded} />
      {doc.missing && (
        <p
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground"
        >
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-client" />
          This was deleted outside the app. Your edits are kept here so you can copy them; it can&apos;t be
          saved.
        </p>
      )}
      {body}
    </section>
  );
}

function DocHeader({ tab, doc, canSave }: { tab: Tab; doc: DocState; canSave: boolean }) {
  const dirty = isDirty(tab);
  const label = KIND_LABELS[doc.kind];
  const [renaming, setRenaming] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const selectedId = useEnvironmentsStore((s) => s.selectedId);
  const envs = useEnvironmentsStore.getState;
  const isEnv = doc.kind === "environment";
  const selected = isEnv && selectedId === doc.targetId;
  const title = tabTitle(tab);

  const menu: MenuEntry[] = [
    { label: "Rename", icon: Pencil, onSelect: () => setRenaming(true) },
    {
      label: "Duplicate",
      icon: Copy,
      onSelect: () =>
        void envs()
          .duplicate(doc.targetId)
          .then((copy) => copy && envs().open(copy.id)),
    },
    "separator",
    {
      label: "Delete",
      icon: Trash2,
      destructive: true,
      onSelect: () =>
        setPendingDelete({
          title: `Delete the environment "${doc.name}"?`,
          description:
            "Its file is removed from the workspace, and its secret values are deleted from this machine. This can't be undone.",
          confirmLabel: "Delete environment",
          onConfirm: () => void envs().remove(doc.targetId),
        }),
    },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <DocKindIcon kind={doc.kind} className="size-4" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {renaming ? (
          <div className="flex max-w-72 flex-1">
            <InlineRename
              initial={doc.name}
              label="Environment name"
              onCommit={(name) => {
                setRenaming(false);
                void envs().rename(doc.targetId, name);
              }}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <h1
            className="truncate text-sm font-semibold"
            onDoubleClick={isEnv ? () => setRenaming(true) : undefined}
          >
            {doc.kind === "environment" || doc.kind === "globals" ? title : doc.name}
          </h1>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        {dirty && <span className="shrink-0 text-xs text-muted-foreground">· Unsaved changes</span>}
      </div>
      {isEnv &&
        (selected ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check aria-hidden className="size-3.5 text-primary" /> In use
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void envs().select(doc.targetId)}>
            Use this environment
          </Button>
        ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={dirty ? "default" : "outline"}
            disabled={!canSave || !dirty || doc.missing}
            onClick={() => void saveDocTab(tab.id)}
          >
            <Save /> Save
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save ({modKeyLabel()}+S)</TooltipContent>
      </Tooltip>
      {isEnv && !doc.missing && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${doc.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
          <ItemMenuContent kind="dropdown" entries={menu} />
        </DropdownMenu>
      )}
      <ConfirmDeleteDialog target={pendingDelete} onClose={() => setPendingDelete(null)} />
    </header>
  );
}

/** Explains precedence and where secret values live. */
function ScopeNote({ children }: { children: React.ReactNode }) {
  const backend = useSecretsStore((s) => s.status?.backend);
  return (
    <div className="mb-3 flex max-w-3xl flex-col gap-1 text-xs text-muted-foreground">
      <p>{children}</p>
      <p>
        Secret values (marked with a lock) are stored{" "}
        {backend === "file" ? "in an encrypted file on this machine" : "in this machine's keychain"}, never in
        the workspace files.
      </p>
    </div>
  );
}

function useVariableHandlers(tab: Tab) {
  const tabs = useTabsStore.getState;
  return {
    onChange: (update: (rows: Variable[]) => Variable[]) =>
      tabs().updateDoc(tab.id, (d) => ({ ...d, variables: update(d.variables) })),
    onSavedOnDisk: (saved: Variable[], update: (rows: Variable[]) => Variable[]) => {
      const current = tabs().tabs.find((t) => t.id === tab.id)?.doc;
      if (current?.saved) tabs().setDocSaved(tab.id, { ...current.saved, variables: saved });
      tabs().updateDoc(tab.id, (d) => ({ ...d, variables: update(d.variables) }));
      if (current?.kind === "collection") useEnvironmentsStore.getState().touch();
      else void useEnvironmentsStore.getState().load();
    },
  };
}

function VariablesBody({ tab, doc }: { tab: Tab; doc: DocState }) {
  const handlers = useVariableHandlers(tab);
  const isGlobals = doc.kind === "globals";
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <ScopeNote>
        {isGlobals
          ? "Global variables are available in every request. Collection variables and the selected environment override them."
          : `While ${doc.name} is the selected environment, its variables override global and collection variables. Use them as {{name}} in URLs, headers, bodies and auth.`}
      </ScopeNote>
      <div className="max-w-3xl">
        <VariablesTable
          label={isGlobals ? "Global variables" : `${doc.name} variables`}
          scope={docScope(doc)!}
          rows={doc.draft!.variables}
          savedRows={doc.saved!.variables}
          {...handlers}
        />
      </div>
    </div>
  );
}

function ContainerBody({ tab, doc }: { tab: Tab; doc: DocState }) {
  const tabs = useTabsStore.getState;
  const collections = useWorkspaceStore((s) => s.collections);
  const handlers = useVariableHandlers(tab);
  const [moving, setMoving] = useState<{ field: SecretField; value: string } | null>(null);
  const isFolder = doc.kind === "folder";
  const draft = doc.draft!;
  const parentId = isFolder ? (positionOf(collections, "folder", doc.targetId)?.parentId ?? "") : "";
  // What a folder set to `inherit` gets: resolve an inheriting request placed in the folder's parent.
  const probe = useMemo(
    () => ({ ...emptyRequest(), auth: { ...emptyRequest().auth, type: "inherit" as const } }),
    [],
  );
  const preview = usePreview(probe, isFolder ? parentId : "");
  const noun = isFolder ? "folder" : "collection";

  return (
    <Tabs defaultValue="auth" className="flex min-h-0 flex-1 flex-col gap-0">
      <TabsList variant="line" className="h-9 w-full shrink-0 justify-start rounded-none border-b px-3">
        <TabsTrigger value="auth" className="flex-none px-2">
          Auth
        </TabsTrigger>
        <TabsTrigger value="headers" className="flex-none px-2">
          Headers
        </TabsTrigger>
        {!isFolder && (
          <TabsTrigger value="variables" className="flex-none px-2">
            Variables
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="auth" className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-4 max-w-xl text-xs text-muted-foreground">
          Requests and folders in this {noun} whose auth is set to &quot;Inherit from parent&quot; use this
          auth.
        </p>
        <AuthEditor
          auth={draft.auth}
          onChange={(update) => tabs().updateDoc(tab.id, (d) => ({ ...d, auth: update(d.auth) }))}
          allowInherit={isFolder}
          inheritInfo={<InheritedAuth state={preview} hasParent={parentId !== ""} subject="folder" />}
          noneInfo={
            isFolder
              ? "Requests here that inherit auth send none, even if the collection sets one."
              : "Requests that inherit auth send none."
          }
          onMoveToSecret={(field, value) => setMoving({ field, value })}
        />
        <MoveToSecretDialog
          value={moving?.value ?? null}
          suggestedName={moving ? SUGGESTED_NAMES[moving.field] : ""}
          collectionId={collectionIdOf(collections, doc.targetId)}
          onMoved={(name) => {
            const field = moving!.field;
            tabs().updateDoc(tab.id, (d) => ({ ...d, auth: { ...d.auth, [field]: `{{${name}}}` } }));
          }}
          onClose={() => setMoving(null)}
        />
      </TabsContent>
      <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
          Every request in this {noun} sends these headers, unless it or a folder below sets a header with the
          same name.
        </p>
        <div className="max-w-3xl">
          <KeyValueTable
            label={`${doc.name} headers`}
            rows={draft.headers}
            keyPlaceholder="Header"
            onChange={(rows) => tabs().updateDoc(tab.id, (d) => ({ ...d, headers: rows }))}
          />
        </div>
      </TabsContent>
      {!isFolder && (
        <TabsContent value="variables" className="min-h-0 flex-1 overflow-auto p-4">
          <ScopeNote>
            Collection variables are available to every request in {doc.name}. They override global variables;
            the selected environment overrides them.
          </ScopeNote>
          <div className="max-w-3xl">
            <VariablesTable
              label={`${doc.name} variables`}
              scope={docScope(doc)!}
              rows={draft.variables}
              savedRows={doc.saved!.variables}
              {...handlers}
            />
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}
