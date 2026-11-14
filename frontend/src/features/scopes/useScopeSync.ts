import { useEffect } from "react";
import { api } from "@/lib/api";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useWorkspaceStore } from "@/stores/workspace";
import { reloadContainerTabs, syncContainerTabs, syncEnvironmentTabs } from "./docActions";

/**
 * Loads environments and the secret store status, and keeps environment and
 * settings tabs in step: on workspace open, on `workspace:changed` (external
 * edits, including `environments/`), and whenever the tree or the
 * environment lists change.
 */
export function useScopeSync(): void {
  useEffect(() => {
    const envs = useEnvironmentsStore.getState;
    void useSecretsStore.getState().refresh();

    let workspaceId = useWorkspaceStore.getState().workspace?.id ?? null;
    if (workspaceId) {
      void envs().load();
      void reloadContainerTabs();
    }

    const offWorkspace = useWorkspaceStore.subscribe((s, prev) => {
      const id = s.workspace?.id ?? null;
      if (id !== workspaceId) {
        workspaceId = id;
        void envs().load();
        if (id) void reloadContainerTabs();
      }
      if (s.collections !== prev.collections || s.treeLoaded !== prev.treeLoaded) syncContainerTabs();
    });
    const offEnvironments = useEnvironmentsStore.subscribe((s, prev) => {
      if (s.environments !== prev.environments || s.globals !== prev.globals || s.status !== prev.status) {
        syncEnvironmentTabs();
      }
    });
    const offChanged = api.onWorkspaceChanged((change) => {
      if (change.workspaceId !== workspaceId) return;
      void envs().load();
      void reloadContainerTabs();
    });
    return () => {
      offWorkspace();
      offEnvironments();
      offChanged();
    };
  }, []);
}
