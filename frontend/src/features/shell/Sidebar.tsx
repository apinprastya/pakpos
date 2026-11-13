import { CollectionsView } from "@/features/sidebar/CollectionsView";
import { HistoryView } from "@/features/sidebar/HistoryView";
import { WorkspaceSwitcher } from "@/features/sidebar/WorkspaceSwitcher";
import { useLayoutStore } from "@/stores/layout";

export function Sidebar() {
  const view = useLayoutStore((s) => s.sidebarView);
  return (
    <aside aria-label="Sidebar" className="flex h-full flex-col bg-sidebar">
      <WorkspaceSwitcher />
      {view === "collections" ? <CollectionsView /> : <HistoryView />}
    </aside>
  );
}
