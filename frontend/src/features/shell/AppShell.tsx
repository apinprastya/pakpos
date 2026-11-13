import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useLayoutStore } from "@/stores/layout";
import { RequestPane } from "@/features/request/RequestPane";
import { ResponsePane } from "@/features/response/ResponsePane";
import { ActivityRail } from "./ActivityRail";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";

const PLACEHOLDER_TABS = [{ id: "draft", title: "Untitled request", method: "GET" }];

export function AppShell() {
  const orientation = useLayoutStore((s) => s.splitOrientation);

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
              <TabBar tabs={PLACEHOLDER_TABS} activeId="draft" />
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
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
    </div>
  );
}
