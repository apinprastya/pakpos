/**
 * The command palette's actions ("> …"). Each action says when it applies
 * (`enabled`) and what it does (`run`); actions that need a choice open a
 * second step (`goTo`) instead of running right away.
 */
import { copyAsCurl } from "@/features/code/actions";
import { saveTab } from "@/features/request/actions";
import { openContainerScripts, openRequestScripts } from "@/features/scripts/open";
import { resetAllScriptValues } from "@/features/scripts/overlay";
import { openRunnerFor } from "@/features/runner/open";
import { exportToPostman } from "@/features/import/exportActions";
import { usePaletteStore } from "@/stores/palette";
import { useRunnerStore } from "@/stores/runner";
import { useConsoleStore } from "@/stores/console";
import type { DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import type { SecretsStatus, WorkspaceInfo } from "@/lib/model";
import { modKeyLabel } from "@/lib/platform";
import { collectionIdOf, destinations } from "@/lib/tree";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { usePostmanImportStore } from "@/stores/postmanImport";
import { useOAuth2Store } from "@/stores/oauth2";
import { useCookiesStore } from "@/stores/cookies";
import { useEnvironmentsStore } from "@/stores/environments";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";
import { useSecretsStore } from "@/stores/secrets";
import { useSettingsStore, type SettingsSection } from "@/stores/settings";
import { isRequestTab as isRequest, useTabsStore, type Tab } from "@/stores/tabs";
import { TOOLS } from "@/features/tools/registry";
import { resolveTheme, useThemeStore } from "@/stores/theme";
import { useTreeStore } from "@/stores/tree";
import { useUpdateStore } from "@/stores/update";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWebhooksStore } from "@/stores/webhooks";
import { copyText } from "@/features/webhooks/actions";
import { startWebhook } from "@/features/webhooks/start";
import { isRunning, statusKey, webhookUrl } from "@/lib/webhookModel";

import type { PalettePage } from "@/stores/palette";

export interface ActionContext {
  /** The active tab. */
  tab: Tab;
  workspace: WorkspaceInfo | null;
  secrets: SecretsStatus | null;
  /** Opens a second step (the palette stays open). */
  goTo: (page: PalettePage) => void;
  /** Asks before a destructive action. */
  confirm: (target: DeleteTarget) => void;
}

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra words the search matches. */
  keywords?: string[];
  group: string;
  /** Shortcut hint, e.g. "Ctrl+S". */
  shortcut?: () => string;
  enabled: (ctx: ActionContext) => boolean;
  run: (ctx: ActionContext) => void;
  /** Opens a second step: the palette stays open. */
  opensPage?: boolean;
}

const mod = (key: string) => () => `${modKeyLabel()}+${key}`;
/** The active tab is a webhook of the open workspace (one from another workspace is read-only). */
const webhookTab = (ctx: ActionContext) =>
  ctx.tab.doc?.kind === "webhook" && !!ctx.workspace && ctx.tab.workspaceId === ctx.workspace.id;
/** The running status of the active webhook tab (any workspace), if it runs. */
function webhookStatus(ctx: ActionContext) {
  if (ctx.tab.doc?.kind !== "webhook") return undefined;
  const st = useWebhooksStore.getState().statuses[statusKey(ctx.tab.workspaceId, ctx.tab.doc.targetId)];
  return isRunning(st) ? st : undefined;
}
const isRequestTab = (ctx: ActionContext) => isRequest(ctx.tab);
const savedRequest = (ctx: ActionContext) => isRequestTab(ctx) && !!ctx.tab.saved?.id && !!ctx.workspace;
const usesFileStore = (ctx: ActionContext) => ctx.secrets?.backend === "file";
/** A request tab, or a collection or folder settings tab: the tabs with scripts. */
const hasScriptsTab = (ctx: ActionContext) =>
  isRequestTab(ctx) || ctx.tab.doc?.kind === "collection" || ctx.tab.doc?.kind === "folder";

/**
 * The OAuth 2.0 token the active tab can get: a saved request with its own
 * OAuth 2.0 auth, or a collection or folder settings tab set to OAuth 2.0.
 */
export function oauth2Target(tab: Tab) {
  if (tab.tool) return null;
  const doc = tab.doc;
  if (doc) {
    if ((doc.kind !== "collection" && doc.kind !== "folder") || doc.draft?.auth.type !== "oauth2")
      return null;
    return { ownerId: doc.targetId, parentId: "", auth: doc.draft.auth, pane: "settings" as const };
  }
  if (tab.request.auth.type !== "oauth2" || !tab.saved?.id) return null;
  return { ownerId: tab.saved.id, parentId: tab.parentId, auth: tab.request.auth, pane: "request" as const };
}

function openScripts(tab: Tab, event: "prerequest" | "test") {
  const doc = tab.doc;
  if (doc && (doc.kind === "collection" || doc.kind === "folder")) {
    openContainerScripts({ kind: doc.kind, id: doc.targetId, name: doc.name }, event);
  } else {
    openRequestScripts(tab.id, event);
  }
}

/**
 * Runs a collection or folder: the active tab's own target (its settings or
 * runner tab), the only one there is, or a second step to choose one.
 */
function runTarget(ctx: ActionContext, kind: "collection" | "folder") {
  const doc = ctx.tab.doc;
  const own =
    doc && (doc.kind === kind || (doc.kind === "runner" && doc.runner?.targetKind === kind))
      ? doc.targetId
      : "";
  const all = destinations(useWorkspaceStore.getState().collections).filter((d) => d.kind === kind);
  const id = own || (all.length === 1 ? all[0].id : "");
  if (id) {
    usePaletteStore.getState().close();
    openRunnerFor(id);
    return;
  }
  ctx.goTo(kind === "collection" ? "run-collection" : "run-folder");
}

const hasContainer = (kind: "collection" | "folder") => (ctx: ActionContext) =>
  !!ctx.workspace && destinations(useWorkspaceStore.getState().collections).some((d) => d.kind === kind);

/**
 * The collection to export: the active tab's own (a collection or folder
 * settings tab, or a saved request), or the only one there is.
 */
export function exportCollectionId(ctx: ActionContext): string {
  if (!ctx.workspace) return "";
  const collections = useWorkspaceStore.getState().collections;
  const doc = ctx.tab.doc;
  let container = "";
  if (doc && (doc.kind === "collection" || doc.kind === "folder")) container = doc.targetId;
  else if (doc?.kind === "runner") container = doc.targetId;
  else if (isRequest(ctx.tab) && ctx.tab.saved?.id && ctx.tab.workspaceId === ctx.workspace.id)
    container = ctx.tab.parentId;
  const own = container ? collectionIdOf(collections, container) : "";
  if (own) return own;
  return collections.length === 1 ? collections[0].id : "";
}

/** The environment to export: the active environment tab's, else the selected one. */
export function exportEnvironmentId(ctx: ActionContext): string {
  if (!ctx.workspace) return "";
  if (ctx.tab.doc?.kind === "environment" && !ctx.tab.doc.missing) return ctx.tab.doc.targetId;
  return useEnvironmentsStore.getState().selectedId;
}

const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "requests", label: "Requests" },
  { id: "network", label: "Network" },
  { id: "history", label: "History" },
  { id: "secrets", label: "Secrets" },
  { id: "about", label: "About" },
];

export const ACTIONS: PaletteAction[] = [
  {
    id: "new-request",
    label: "New request",
    keywords: ["tab", "create"],
    group: "Requests",
    shortcut: mod("T"),
    enabled: () => true,
    run: () => void useTabsStore.getState().newTab(),
  },
  {
    id: "save",
    label: "Save",
    group: "Requests",
    shortcut: mod("S"),
    enabled: (ctx) => !ctx.tab.tool,
    run: (ctx) => void saveTab(ctx.tab.id),
  },
  {
    id: "save-as",
    label: "Save as…",
    keywords: ["copy", "collection"],
    group: "Requests",
    enabled: isRequestTab,
    run: (ctx) => useTabsStore.getState().openSaveDialog(ctx.tab.id),
  },
  {
    id: "close-tab",
    label: "Close tab",
    group: "Requests",
    shortcut: mod("W"),
    enabled: () => true,
    run: (ctx) => useTabsStore.getState().requestClose(ctx.tab.id),
  },
  {
    id: "import-curl",
    label: "Import cURL…",
    keywords: ["paste", "curl", "command"],
    group: "Requests",
    enabled: () => true,
    run: () => useCodeDialogsStore.getState().openImport(),
  },
  {
    id: "copy-curl",
    label: "Copy as cURL",
    keywords: ["clipboard", "curl"],
    group: "Requests",
    enabled: (ctx) => isRequestTab(ctx) && ctx.tab.request.url.trim() !== "",
    run: (ctx) => void copyAsCurl(ctx.tab.request, ctx.tab.parentId),
  },
  {
    id: "generate-code",
    label: "Generate code…",
    keywords: ["snippet", "python", "javascript", "go", "java", "php", "fetch", "axios"],
    group: "Requests",
    shortcut: mod("Shift+C"),
    enabled: isRequestTab,
    run: (ctx) => useCodeDialogsStore.getState().openCode(ctx.tab.id),
  },
  {
    id: "open-prerequest-script",
    label: "Open pre-request script",
    keywords: ["scripts", "javascript", "pm"],
    group: "Scripts",
    enabled: hasScriptsTab,
    run: (ctx) => openScripts(ctx.tab, "prerequest"),
  },
  {
    id: "open-tests",
    label: "Open tests",
    keywords: ["scripts", "test script", "assertions", "pm.test"],
    group: "Scripts",
    enabled: hasScriptsTab,
    run: (ctx) => openScripts(ctx.tab, "test"),
  },
  {
    id: "get-oauth2-token",
    label: "Get new OAuth 2.0 token",
    keywords: ["oauth", "access token", "authorize", "sign in", "login"],
    group: "Requests",
    enabled: (ctx) => !!ctx.workspace && oauth2Target(ctx.tab) !== null,
    run: (ctx) => {
      const t = oauth2Target(ctx.tab)!;
      useTabsStore.getState().setSection(ctx.tab.id, t.pane, "auth");
      void useOAuth2Store.getState().start(t.ownerId, t.parentId, t.auth);
    },
  },
  {
    id: "toggle-console",
    label: "Toggle console",
    keywords: ["log", "output", "scripts", "drawer"],
    group: "Scripts",
    shortcut: mod("J"),
    enabled: () => true,
    run: () => useConsoleStore.getState().toggle(),
  },
  {
    id: "clear-console",
    label: "Clear console",
    keywords: ["log", "output"],
    group: "Scripts",
    enabled: () => useConsoleStore.getState().groups.length > 0,
    run: () => useConsoleStore.getState().clear(),
  },
  {
    id: "run-collection",
    label: "Run collection…",
    keywords: ["runner", "test", "iterations", "data"],
    group: "Runner",
    enabled: hasContainer("collection"),
    opensPage: true,
    run: (ctx) => runTarget(ctx, "collection"),
  },
  {
    id: "run-folder",
    label: "Run folder…",
    keywords: ["runner", "test", "iterations", "data"],
    group: "Runner",
    enabled: hasContainer("folder"),
    opensPage: true,
    run: (ctx) => runTarget(ctx, "folder"),
  },
  {
    id: "open-run-history",
    label: "Open run history",
    keywords: ["runner", "past runs", "results", "report"],
    group: "Runner",
    enabled: (ctx) => !!ctx.workspace,
    opensPage: true,
    run: (ctx) => {
      void useRunnerStore.getState().loadPast();
      ctx.goTo("run-history");
    },
  },
  {
    id: "new-webhook",
    label: "New webhook",
    keywords: ["webhook", "tunnel", "cloudflare", "receive", "callback"],
    group: "Webhooks",
    enabled: (ctx) => !!ctx.workspace,
    run: () => {
      useLayoutStore.getState().setSidebarView("webhooks");
      void useWebhooksStore.getState().create();
    },
  },
  {
    id: "open-webhooks",
    label: "Open webhooks",
    keywords: ["webhook", "tunnel", "requests", "log"],
    group: "Webhooks",
    enabled: () => true,
    run: () => useLayoutStore.getState().setSidebarView("webhooks"),
  },
  {
    id: "start-webhook",
    label: "Start webhook with public tunnel",
    keywords: ["webhook", "tunnel", "cloudflare", "run"],
    group: "Webhooks",
    enabled: (ctx) => webhookTab(ctx) && !webhookStatus(ctx),
    run: (ctx) => void startWebhook(ctx.tab.doc!.targetId, true),
  },
  {
    id: "start-webhook-local",
    label: "Start webhook locally",
    keywords: ["webhook", "local", "run"],
    group: "Webhooks",
    enabled: (ctx) => webhookTab(ctx) && !webhookStatus(ctx),
    run: (ctx) => void startWebhook(ctx.tab.doc!.targetId, false),
  },
  {
    id: "stop-webhook",
    label: "Stop webhook",
    keywords: ["webhook", "tunnel"],
    group: "Webhooks",
    enabled: (ctx) => !!webhookStatus(ctx),
    run: (ctx) => void useWebhooksStore.getState().stop(ctx.tab.workspaceId, ctx.tab.doc!.targetId),
  },
  {
    id: "copy-webhook-url",
    label: "Copy webhook URL",
    keywords: ["webhook", "tunnel", "link", "public"],
    group: "Webhooks",
    enabled: (ctx) => !!webhookStatus(ctx),
    run: (ctx) => void copyText(webhookUrl(webhookStatus(ctx)), "URL"),
  },
  {
    id: "reset-script-values",
    label: "Reset script values",
    keywords: ["overlay", "variables", "set by script", "pm.environment"],
    group: "Scripts",
    enabled: (ctx) => !!ctx.workspace,
    run: () => void resetAllScriptValues(),
  },
  {
    id: "reveal-request",
    label: "Reveal current request in sidebar",
    keywords: ["tree", "show", "locate", "find"],
    group: "Requests",
    enabled: savedRequest,
    run: (ctx) => void useTreeStore.getState().revealInTree(ctx.tab.saved!.id, { show: true }),
  },
  {
    id: "move-request",
    label: "Move current request to…",
    keywords: ["folder", "collection"],
    group: "Requests",
    enabled: savedRequest,
    opensPage: true,
    run: (ctx) => ctx.goTo("move"),
  },
  {
    id: "new-collection",
    label: "New collection",
    group: "Workspace",
    enabled: (ctx) => !!ctx.workspace,
    run: () => {
      useLayoutStore.getState().setSidebarView("collections");
      void useWorkspaceStore.getState().createCollection();
    },
  },
  {
    id: "import-postman",
    label: "Import from Postman…",
    keywords: ["collection", "environment", "globals", "export", "json"],
    group: "Workspace",
    enabled: (ctx) => !!ctx.workspace,
    run: () => usePostmanImportStore.getState().openDialog(),
  },
  {
    id: "export-collection-postman",
    label: "Export collection to Postman…",
    keywords: ["json", "share", "download"],
    group: "Workspace",
    enabled: (ctx) => !!exportCollectionId(ctx),
    run: (ctx) => void exportToPostman({ kind: "collection", id: exportCollectionId(ctx) }),
  },
  {
    id: "export-environment-postman",
    label: "Export environment to Postman…",
    keywords: ["json", "share", "download", "variables"],
    group: "Workspace",
    enabled: (ctx) => !!exportEnvironmentId(ctx),
    run: (ctx) => void exportToPostman({ kind: "environment", id: exportEnvironmentId(ctx) }),
  },
  {
    id: "export-globals-postman",
    label: "Export globals to Postman…",
    keywords: ["json", "share", "download", "variables"],
    group: "Workspace",
    enabled: (ctx) => !!ctx.workspace,
    run: () => void exportToPostman({ kind: "globals" }),
  },
  {
    id: "new-folder",
    label: "New folder",
    keywords: ["here", "next to request"],
    group: "Workspace",
    enabled: (ctx) => savedRequest(ctx) && !!ctx.tab.parentId,
    run: (ctx) => {
      const parentId = ctx.tab.parentId;
      useTreeStore.getState().revealInTree(parentId, { show: true });
      void useWorkspaceStore.getState().createFolder(parentId);
    },
  },
  {
    id: "open-workspace",
    label: "Open workspace…",
    keywords: ["folder"],
    group: "Workspace",
    enabled: () => true,
    run: () => void useWorkspaceStore.getState().openFolder(),
  },
  {
    id: "create-workspace",
    label: "Create workspace…",
    keywords: ["new", "folder"],
    group: "Workspace",
    enabled: () => true,
    run: () => void useWorkspaceStore.getState().createInFolder(),
  },
  {
    id: "close-workspace",
    label: "Close workspace",
    group: "Workspace",
    enabled: (ctx) => !!ctx.workspace,
    run: () => void useWorkspaceStore.getState().close(),
  },
  {
    id: "manage-cookies",
    label: "Manage cookies",
    keywords: ["cookie jar", "session", "delete cookies"],
    group: "Workspace",
    enabled: () => true,
    run: () => useCookiesStore.getState().openManager(),
  },
  {
    id: "clear-history",
    label: "Clear history…",
    keywords: ["delete", "sent"],
    group: "Workspace",
    enabled: () => true,
    run: (ctx) =>
      ctx.confirm({
        title: ctx.workspace ? `Clear history of ${ctx.workspace.name}?` : "Clear history?",
        description: ctx.workspace
          ? "This deletes every entry sent in this workspace. Other workspaces and saved requests aren't affected."
          : "This deletes every entry sent without a workspace. Workspace history and saved requests aren't affected.",
        confirmLabel: "Clear history",
        onConfirm: () => void useHistoryStore.getState().clear(),
      }),
  },
  {
    id: "switch-environment",
    label: "Switch environment…",
    keywords: ["select", "use", "dev", "staging", "prod"],
    group: "Environments",
    enabled: (ctx) => !!ctx.workspace,
    opensPage: true,
    run: (ctx) => ctx.goTo("environment"),
  },
  {
    id: "manage-environments",
    label: "Manage environments",
    keywords: ["variables"],
    group: "Environments",
    enabled: (ctx) => !!ctx.workspace,
    run: () => useLayoutStore.getState().setSidebarView("environments"),
  },
  {
    id: "edit-globals",
    label: "Edit globals",
    keywords: ["global variables"],
    group: "Environments",
    enabled: (ctx) => !!ctx.workspace,
    run: () => useEnvironmentsStore.getState().openGlobals(),
  },
  {
    id: "unlock-secrets",
    label: "Unlock secrets…",
    keywords: ["master password"],
    group: "Secrets",
    enabled: (ctx) => usesFileStore(ctx) && !!ctx.secrets?.hasPassword && !!ctx.secrets.locked,
    run: () => useSecretsStore.getState().openDialog("unlock"),
  },
  {
    id: "lock-secrets",
    label: "Lock secrets",
    group: "Secrets",
    enabled: (ctx) => usesFileStore(ctx) && !!ctx.secrets?.hasPassword && !ctx.secrets.locked,
    run: () => void useSecretsStore.getState().lock(),
  },
  {
    id: "change-master-password",
    label: "Change master password…",
    keywords: ["secrets"],
    group: "Secrets",
    enabled: (ctx) => usesFileStore(ctx) && !!ctx.secrets?.hasPassword,
    run: () => useSecretsStore.getState().openDialog("change-password"),
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    keywords: ["dark", "light", "appearance"],
    group: "View",
    enabled: () => true,
    run: () => {
      const mode = useThemeStore.getState().mode;
      const dark = resolveTheme(mode, window.matchMedia("(prefers-color-scheme: dark)").matches) === "dark";
      void useSettingsStore.getState().setTheme(dark ? "light" : "dark");
    },
  },
  {
    id: "toggle-response-position",
    label: "Toggle response position",
    keywords: ["layout", "split", "beside", "below"],
    group: "View",
    enabled: () => true,
    run: () => {
      const vertical = useLayoutStore.getState().splitOrientation === "vertical";
      void useSettingsStore.getState().setLayout(vertical ? "horizontal" : "vertical");
    },
  },
  {
    id: "open-settings",
    label: "Open settings",
    keywords: ["preferences"],
    group: "View",
    shortcut: mod(","),
    enabled: () => true,
    run: () => useSettingsStore.getState().openDialog(),
  },
  ...SETTINGS_SECTIONS.map((s): PaletteAction => ({
    id: `settings-${s.id}`,
    label: `Settings: ${s.label}`,
    keywords: ["preferences"],
    group: "View",
    enabled: () => true,
    run: () => useSettingsStore.getState().openDialog(s.id),
  })),
  ...TOOLS.map((t): PaletteAction => ({
    id: `open-tool-${t.id}`,
    label: `Open ${t.label}`,
    keywords: ["tools", ...t.keywords],
    group: "Tools",
    enabled: () => true,
    run: () => void useTabsStore.getState().openTool(t.id),
  })),
  {
    id: "check-for-updates",
    label: "Check for updates",
    keywords: ["upgrade", "version", "release"],
    group: "Help",
    enabled: () => true,
    run: () => void useUpdateStore.getState().check(),
  },
];

/** The actions that apply in `ctx`, in registry order. */
export function availableActions(ctx: ActionContext, actions: PaletteAction[] = ACTIONS): PaletteAction[] {
  return actions.filter((a) => a.enabled(ctx));
}
