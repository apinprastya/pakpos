import { useSettingsStore } from "@/stores/settings";
import { DEFAULT_SETTINGS } from "@/lib/model";
import { emptyRequest, type Request } from "@/lib/model";
import { useHistoryStore } from "@/stores/history";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";

const workspaceInitial = useWorkspaceStore.getState();
const historyInitial = useHistoryStore.getState();
const environmentsInitial = useEnvironmentsStore.getState();
const secretsInitial = useSecretsStore.getState();

/** Puts the workspace and history stores back to their start state (run before each test). */
export function resetSidebarStores(): void {
  useWorkspaceStore.setState(workspaceInitial, true);
  useHistoryStore.setState(historyInitial, true);
  useEnvironmentsStore.setState(environmentsInitial, true);
  useSecretsStore.setState(secretsInitial, true);
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    loaded: false,
    dialogOpen: false,
    section: "appearance",
  });
}

/** Resets the tabs store to a single tab with the given request. */
export function resetTabs(request: Partial<Request> = {}, tab: Partial<Tab> = {}): Tab {
  const t: Tab = {
    id: "t1",
    request: { ...emptyRequest(), ...request },
    saved: null,
    parentId: "",
    workspaceId: "",
    sendId: null,
    result: null,
    ...tab,
    doc: tab.doc ?? null,
  };
  useTabsStore.setState({ tabs: [t], activeId: t.id, pendingCloseId: null, saveDialog: null });
  return t;
}

export function activeTab(): Tab {
  const s = useTabsStore.getState();
  return s.tabs.find((t) => t.id === s.activeId)!;
}
