import { CollectionsView } from "@/features/sidebar/CollectionsView";
import { EnvironmentsView } from "@/features/environments/EnvironmentsView";
import { HistoryView } from "@/features/sidebar/HistoryView";
import { ToolsSidebar } from "@/features/tools/ToolsSidebar";
import { WorkspaceSwitcher } from "@/features/sidebar/WorkspaceSwitcher";
import { useLayoutStore } from "@/stores/layout";
import { TitleBarSpace } from "./TitleBarSpace";

export function Sidebar() {
  const view = useLayoutStore((s) => s.sidebarView);
  return (
    <aside aria-label="Sidebar" className="flex h-full flex-col bg-sidebar">
      <div className="flex shrink-0">
        <TitleBarSpace className="w-8" />
        <WorkspaceSwitcher />
      </div>
      {view === "collections" && <CollectionsView />}
      {view === "environments" && <EnvironmentsView />}
      {view === "history" && <HistoryView />}
      {view === "tools" && <ToolsSidebar />}
    </aside>
  );
}
