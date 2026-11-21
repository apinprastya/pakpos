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
import { useSettingsStore } from "@/stores/settings";
import { useEffect } from "react";
import { useActiveTab } from "@/stores/tabs";
import { DocEditor } from "@/features/scopes/DocEditor";
import { RunnerView } from "@/features/runner/lazy";
import { WebhookView } from "@/features/webhooks/lazy";
import { useWebhooksSync } from "@/features/webhooks/useWebhooksSync";
import { ToolTab } from "@/features/tools/ToolTab";
import { useScopeSync } from "@/features/scopes/useScopeSync";
import { SecretsDialogs } from "@/features/secrets/SecretsDialogs";
import { useDismissToastsOnDialog } from "@/lib/dialogToasts";
import { useExamplesSync } from "@/features/examples/useExamplesSync";
import { LazyDialogs } from "./LazyDialogs";
import { useUpdateCheck } from "@/features/update/useUpdateCheck";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useConsoleSync } from "@/features/console/useConsoleSync";
import { ConsolePanel } from "@/features/console/ConsolePanel";

export function AppShell() {
  const orientation = useLayoutStore((s) => s.splitOrientation);
  useShortcuts();
  useWorkspaceSync();
  useScopeSync();
  useDismissToastsOnDialog();
  useExamplesSync();
  useUpdateCheck();
  useConsoleSync();
  useWebhooksSync();
  const active = useActiveTab();
  const mainLayout = usePanelLayout("main");
  const splitLayout = usePanelLayout(`split-${orientation}`);
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        <ResizablePanelGroup orientation="horizontal" id="pakpos-main" {...mainLayout}>
          <ResizablePanel id="sidebar" defaultSize={260} minSize={200} maxSize="40">
            <Sidebar />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="workspace" minSize="40">
            <main className="flex h-full min-w-0 flex-col">
              <TabBar />
              <ConsolePanel>
                {active.tool ? (
                  <ToolTab key={active.id} tab={active} />
                ) : active.doc?.kind === "runner" ? (
                  <RunnerView key={active.id} tab={active} />
                ) : active.doc?.kind === "webhook" ? (
                  <WebhookView key={active.id} tab={active} />
                ) : active.doc ? (
                  <DocEditor key={active.id} tab={active} />
                ) : (
                  <ResizablePanelGroup
                    key={orientation}
                    orientation={orientation === "vertical" ? "vertical" : "horizontal"}
                    id={`pakpos-split-${orientation}`}
                    {...splitLayout}
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
              </ConsolePanel>
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      <CloseTabDialog />
      <SaveRequestDialog />
      <SecretsDialogs />
      <LazyDialogs />
    </div>
  );
}
