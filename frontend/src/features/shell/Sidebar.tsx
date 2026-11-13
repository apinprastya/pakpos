import { FolderOpen, History } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";

export function Sidebar() {
  const view = useLayoutStore((s) => s.sidebarView);

  return (
    <aside aria-label="Sidebar" className="flex h-full flex-col bg-sidebar">
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-semibold">
        {view === "collections" ? "Collections" : "History"}
      </header>
      {view === "collections" ? (
        <EmptyState
          icon={<FolderOpen className="size-6" />}
          title="No workspace open"
          body="Open a folder to keep your requests as files you can commit to git."
        />
      ) : (
        <EmptyState
          icon={<History className="size-6" />}
          title="No requests sent yet"
          body="Every request you send is listed here, so you can reopen it later."
        />
      )}
    </aside>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="font-medium">{title}</p>
      <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
