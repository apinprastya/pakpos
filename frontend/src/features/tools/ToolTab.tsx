import { Suspense, useCallback } from "react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/features/sidebar/EmptyState";
import { useTabsStore, type Tab } from "@/stores/tabs";
import { toolDef } from "./registry";

/** A tool tab: mounts the tool's lazy component with the tab's state. */
export function ToolTab({ tab }: { tab: Tab }) {
  const tool = tab.tool!;
  const def = toolDef(tool.id);
  const update = useCallback(
    (fn: (state: unknown) => unknown) => useTabsStore.getState().updateToolState(tab.id, fn),
    [tab.id],
  );

  if (!def) {
    return (
      <EmptyState
        icon={<Wrench className="size-6" />}
        title="This tool isn't available"
        body={`This version of Pakpos has no tool called "${tool.id}". Close the tab, or open another tool from the Tools view.`}
      >
        <Button size="sm" variant="outline" onClick={() => useTabsStore.getState().close(tab.id)}>
          Close tab
        </Button>
      </EmptyState>
    );
  }
  const Component = def.component;
  return (
    <Suspense
      fallback={
        <p role="status" className="p-3 text-xs text-muted-foreground">
          Loading the {def.label}…
        </p>
      }
    >
      <Component tabId={tab.id} state={tool.state} update={update} />
    </Suspense>
  );
}
