import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { ScopeRef } from "@/lib/model";
import { useEnvironmentsStore } from "@/stores/environments";
import { useWorkspaceStore } from "@/stores/workspace";

/** Every scope a script can set values on in the open workspace: globals, environments, collections. */
export function workspaceScopes(): ScopeRef[] {
  const envs = useEnvironmentsStore.getState().environments;
  const collections = useWorkspaceStore.getState().collections;
  return [
    { kind: "global", id: "" },
    ...envs.map((e): ScopeRef => ({ kind: "environment", id: e.id })),
    ...collections.map((c): ScopeRef => ({ kind: "collection", id: c.id })),
  ];
}

/** Drops every value scripts set in this session; the files and secret store keep theirs. */
export async function resetAllScriptValues(): Promise<void> {
  try {
    await Promise.all(workspaceScopes().map((scope) => api.resetOverlay(scope, "")));
    toast.success("Script values reset", { description: "Variables use the values in their files again." });
  } catch (e) {
    toast.error("Couldn't reset the script values", { description: errorMessage(e) });
  }
  useEnvironmentsStore.getState().touch();
}
