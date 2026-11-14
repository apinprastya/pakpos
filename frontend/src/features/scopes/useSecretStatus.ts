import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ScopeRef, Variable } from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";

export interface SecretStatusView {
  /** Saved secret keys with a value on this machine. */
  set: ReadonlySet<string>;
  /** The store is locked, so whether values exist can't be known. */
  locked: boolean;
  error: string | null;
  refresh: () => void;
}

interface Answer {
  key: string;
  set: ReadonlySet<string>;
  locked: boolean;
  error: string | null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Which saved secrets of a scope have a value on this machine (never the
 * values). Reloads when the saved secret keys or the store's lock state change.
 */
export function useSecretStatus(scope: ScopeRef | null, saved: Variable[]): SecretStatusView {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tick, setTick] = useState(0);
  const storeStatus = useSecretsStore((s) => s.status);

  const secretKeys = saved
    .filter((v) => v.secret)
    .map((v) => v.key)
    .join("\n");
  const storeKey = storeStatus
    ? `${storeStatus.backend}:${storeStatus.hasPassword}:${storeStatus.locked}`
    : "";
  const kind = scope?.kind;
  const id = scope?.id ?? "";
  const key = kind && secretKeys ? JSON.stringify([kind, id, secretKeys, storeKey, tick]) : "";

  useEffect(() => {
    if (!key || !kind) return;
    let live = true;
    api.secretStatus({ kind, id }).then(
      (st) => live && setAnswer({ key, set: new Set(st.set), locked: st.locked, error: null }),
      (e: unknown) =>
        live &&
        setAnswer({ key, set: NONE, locked: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key, kind, id]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  if (!key || !answer) return { set: NONE, locked: false, error: null, refresh };
  // A previous answer stays in place until the new one arrives, so rows don't flicker.
  return { set: answer.set, locked: answer.locked, error: answer.error, refresh };
}
