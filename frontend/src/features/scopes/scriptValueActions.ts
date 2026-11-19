import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { OverlayValue, ScopeRef, Variable } from "@/lib/model";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";

/** Replaces the draft rows named `key` with what was persisted (none for an unset). */
export function applyPersisted(rows: Variable[], saved: Variable[], key: string): Variable[] {
  const persisted = saved.filter((v) => v.key === key);
  const at = rows.findIndex((r) => r.key.trim() === key);
  const others = rows.filter((r) => r.key.trim() !== key);
  if (at < 0) return [...others, ...persisted];
  return [...others.slice(0, at), ...persisted, ...others.slice(at)];
}

/** Reset and persist for one scope's script values; both refresh what shows them. */
export function useScriptValueActions(
  scope: ScopeRef,
  refresh: () => void,
  onSavedOnDisk: (saved: Variable[], update: (rows: Variable[]) => Variable[]) => void,
) {
  const reset = async (key: string) => {
    try {
      await api.resetOverlay(scope, key);
    } catch (e) {
      toast.error("Couldn't reset the script value", { description: errorMessage(e) });
    }
    refresh();
    useEnvironmentsStore.getState().touch();
  };
  const persist = async (v: OverlayValue) => {
    // A secret's value goes to the secret store.
    if (v.secret && !(await useSecretsStore.getState().ensureReady())) return;
    try {
      const saved = await api.persistOverlay(scope, v.key);
      onSavedOnDisk(saved, (rows) => applyPersisted(rows, saved, v.key));
      toast.success(
        v.state === "unset"
          ? `Removed {{${v.key}}} from the file`
          : v.secret
            ? `Stored {{${v.key}}} on this machine`
            : `Saved {{${v.key}}} to the file`,
      );
    } catch (e) {
      toast.error("Couldn't persist the script value", { description: errorMessage(e) });
    }
    refresh();
  };
  return { reset, persist };
}
