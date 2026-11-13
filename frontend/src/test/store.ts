import { emptyRequest, type Request } from "@/lib/model";
import { useTabsStore, type Tab } from "@/stores/tabs";

/** Resets the tabs store to a single tab with the given request. */
export function resetTabs(request: Partial<Request> = {}, tab: Partial<Tab> = {}): Tab {
  const t: Tab = {
    id: "t1",
    request: { ...emptyRequest(), ...request },
    saved: null,
    collectionId: "",
    sendId: null,
    result: null,
    ...tab,
  };
  useTabsStore.setState({ tabs: [t], activeId: t.id, pendingCloseId: null, saveDialog: null });
  return t;
}

export function activeTab(): Tab {
  const s = useTabsStore.getState();
  return s.tabs.find((t) => t.id === s.activeId)!;
}
