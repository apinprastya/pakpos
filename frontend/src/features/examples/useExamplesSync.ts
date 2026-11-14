import { useEffect } from "react";
import { useExamplesStore } from "@/stores/examples";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Keeps the examples cache in step with the workspace: reloads when a
 * workspace opens or closes and after every tree reload, which follows
 * `workspace:changed` and the app's own writes (renames, moves, duplicates
 * and deletes change examples too).
 */
export function useExamplesSync(): void {
  useEffect(() => {
    void useExamplesStore.getState().load();
    return useWorkspaceStore.subscribe((s, prev) => {
      if (s.workspace?.id !== prev.workspace?.id || s.collections !== prev.collections) {
        void useExamplesStore.getState().load();
      }
    });
  }, []);
}
