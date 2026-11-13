import { useEffect } from "react";
import { api } from "@/lib/api";
import { useWorkspaceStore } from "@/stores/workspace";

/** Restores the workspace on start and follows changes made to its files outside the app. */
export function useWorkspaceSync() {
  useEffect(() => {
    const store = useWorkspaceStore.getState;
    void store().init();
    return api.onWorkspaceChanged((change) => void store().handleChange(change));
  }, []);
}
