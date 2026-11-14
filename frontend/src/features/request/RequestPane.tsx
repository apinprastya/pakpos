import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VarScopeContext } from "@/components/editor/varScopeContext";
import { useVariableScope } from "@/features/variables/useVariableScope";
import type { Request } from "@/lib/model";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { cancelTab, sendTab } from "./actions";
import { AuthSection } from "./AuthSection";
import { BodySection } from "./BodySection";
import { HeadersSection } from "./HeadersSection";
import { ParamsSection } from "./ParamsSection";
import { UrlBar } from "./UrlBar";
import { usePreview } from "./usePreview";

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground tabular-nums">{n}</span>;
}

function Dot({ on, label }: { on: boolean; label: string }) {
  if (!on) return null;
  return <span aria-label={label} className="size-1.5 rounded-full bg-primary" />;
}

export function RequestPane() {
  const tab = useActiveTab();
  const updateRequest = useTabsStore((s) => s.updateRequest);
  const req = tab.request;
  const onChange = (update: (r: Request) => Request) => updateRequest(tab.id, update);
  const preview = usePreview(req, tab.parentId);
  const varScope = useVariableScope(tab, preview);
  const hasWorkspace = useWorkspaceStore((s) => s.workspace !== null);
  const inCollection = hasWorkspace && tab.parentId !== "";

  const paramCount = req.query.filter((q) => q.enabled && q.key).length + req.pathParams.length;
  const headerCount = req.headers.filter((h) => h.enabled && h.key).length;

  return (
    <VarScopeContext.Provider value={varScope}>
      <section aria-label="Request" className="flex h-full min-h-0 flex-col">
        <UrlBar
          tabKey={tab.id}
          request={req}
          sending={tab.sendId !== null}
          onChange={onChange}
          onSend={() => void sendTab(tab.id)}
          onCancel={() => void cancelTab(tab.id)}
        />
        <Tabs defaultValue="params" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="h-9 w-full shrink-0 justify-start rounded-none border-b px-3">
            <TabsTrigger value="params" className="flex-none px-2">
              Params <Count n={paramCount} />
            </TabsTrigger>
            <TabsTrigger value="headers" className="flex-none px-2">
              Headers <Count n={headerCount} />
            </TabsTrigger>
            <TabsTrigger value="body" className="flex-none px-2">
              Body <Dot on={req.body.type !== "none"} label="has body" />
            </TabsTrigger>
            <TabsTrigger value="auth" className="flex-none px-2">
              Auth <Dot on={req.auth.type !== "none"} label="auth set" />
            </TabsTrigger>
          </TabsList>
          {/* Keyed by tab so section state (e.g. bulk edit) resets when switching requests. */}
          <TabsContent key={`p-${tab.id}`} value="params" className="min-h-0 flex-1 overflow-auto p-3">
            <ParamsSection request={req} onChange={onChange} />
          </TabsContent>
          <TabsContent key={`h-${tab.id}`} value="headers" className="min-h-0 flex-1 overflow-auto p-3">
            <HeadersSection request={req} onChange={onChange} preview={inCollection ? preview : undefined} />
          </TabsContent>
          <TabsContent key={`b-${tab.id}`} value="body" className="min-h-0 flex-1 overflow-auto p-3">
            <BodySection tabKey={tab.id} request={req} onChange={onChange} />
          </TabsContent>
          <TabsContent key={`a-${tab.id}`} value="auth" className="min-h-0 flex-1 overflow-auto p-3">
            <AuthSection request={req} parentId={tab.parentId} preview={preview} onChange={onChange} />
          </TabsContent>
        </Tabs>
      </section>
    </VarScopeContext.Provider>
  );
}
