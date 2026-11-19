import { lazy, Suspense, type ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useConsoleStore } from "@/stores/console";
import { loadConsole } from "@/features/shell/dialogChunks";

const ConsoleDrawer = lazy(() => loadConsole().then((m) => ({ default: m.ConsoleDrawer })));

/**
 * The editors above, and the console drawer below them while it's open.
 * The editors stay mounted when the console opens or closes (same element
 * position), so editor state and undo history survive. The drawer's height
 * is remembered (ui_state `panels.console`) while it's open.
 */
export function ConsolePanel({ children }: { children: ReactNode }) {
  const open = useConsoleStore((s) => s.open);
  const { defaultLayout, onLayoutChanged } = usePanelLayout("console");
  const size = defaultLayout?.console ?? 30;
  return (
    <ResizablePanelGroup
      orientation="vertical"
      id="pakpos-console"
      className="min-h-0 flex-1"
      onLayoutChanged={(layout) => {
        if (layout.console !== undefined) onLayoutChanged(layout);
      }}
    >
      <ResizablePanel id="editors" minSize="20">
        {children}
      </ResizablePanel>
      {open && <ResizableHandle />}
      {open && (
        <ResizablePanel id="console" defaultSize={String(size)} minSize="10" maxSize="80">
          <Suspense
            fallback={
              <p role="status" className="p-3 text-xs text-muted-foreground">
                Loading the console…
              </p>
            }
          >
            <ConsoleDrawer />
          </Suspense>
        </ResizablePanel>
      )}
    </ResizablePanelGroup>
  );
}
