/**
 * The command palette's actions ("> …"). Each action says when it applies
 * (`enabled`) and what it does (`run`); actions that need a choice open a
 * second step (`goTo`) instead of running right away.
 */
import { copyAsCurl } from "@/features/code/actions";
import { saveTab } from "@/features/request/actions";
import type { DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";
import type { SecretsStatus, WorkspaceInfo } from "@/lib/model";
import { modKeyLabel } from "@/lib/platform";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useEnvironmentsStore } from "@/stores/environments";
import { useHistoryStore } from "@/stores/history";
import { useLayoutStore } from "@/stores/layout";
import { useSecretsStore } from "@/stores/secrets";
import { useSettingsStore, type SettingsSection } from "@/stores/settings";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { resolveTheme, useThemeStore } from "@/stores/theme";
import { useTreeStore } from "@/stores/tree";
import { useUpdateStore } from "@/stores/update";
import { useWorkspaceStore } from "@/stores/workspace";

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
const isRequestTab = (ctx: ActionContext) => !ctx.tab.doc;
const savedRequest = (ctx: ActionContext) => !ctx.tab.doc && !!ctx.tab.saved?.id && !!ctx.workspace;
const usesFileStore = (ctx: ActionContext) => ctx.secrets?.backend === "file";

const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "requests", label: "Requests" },
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
    enabled: () => true,
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
