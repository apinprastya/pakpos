import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useLayoutStore } from "@/stores/layout";
import { RequestPane } from "@/features/request/RequestPane";
import { ResponsePane } from "@/features/response/ResponsePane";
import { ActivityRail } from "./ActivityRail";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { CloseTabDialog } from "./CloseTabDialog";
import { SaveRequestDialog } from "./SaveRequestDialog";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useWorkspaceSync } from "@/hooks/useWorkspaceSync";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { useSettingsStore } from "@/stores/settings";
import { useEffect } from "react";
import { useActiveTab } from "@/stores/tabs";
import { DocEditor } from "@/features/scopes/DocEditor";
import { useScopeSync } from "@/features/scopes/useScopeSync";
import { SecretsDialogs } from "@/features/secrets/SecretsDialogs";

export function AppShell() {
  const orientation = useLayoutStore((s) => s.splitOrientation);
  useShortcuts();
  useWorkspaceSync();
  useScopeSync();
  const active = useActiveTab();
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        <ResizablePanelGroup orientation="horizontal" id="pakpos-main">
          <ResizablePanel id="sidebar" defaultSize={260} minSize={200} maxSize="40">
            <Sidebar />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="workspace" minSize="40">
            <main className="flex h-full min-w-0 flex-col">
              <TabBar />
              {active.doc ? (
                <DocEditor key={active.id} tab={active} />
              ) : (
                <ResizablePanelGroup
                  key={orientation}
                  orientation={orientation === "vertical" ? "vertical" : "horizontal"}
                  id={`pakpos-split-${orientation}`}
                >
                  <ResizablePanel id="request" defaultSize="50" minSize="20">
                    <RequestPane />
                  </ResizablePanel>
                  <ResizableHandle />
                  <ResizablePanel id="response" defaultSize="50" minSize="20">
                    <ResponsePane />
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      <CloseTabDialog />
      <SaveRequestDialog />
      <SettingsDialog />
      <SecretsDialogs />
    </div>
  );
}
