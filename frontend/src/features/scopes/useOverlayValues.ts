import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { OverlayValue, ScopeRef } from "@/lib/model";
import { useEnvironmentsStore } from "@/stores/environments";
import { useWorkspaceStore } from "@/stores/workspace";

interface Answer {
  key: string;
  values: OverlayValue[];
}

const NONE: OverlayValue[] = [];

/**
 * The values scripts set on a scope this session (`EnvService.OverlayValues`;
 * secret values are never returned). Re-read after every send and change to
 * variables (`environments.version`), and on `refresh`.
 */
export function useOverlayValues(scope: ScopeRef): { values: OverlayValue[]; refresh: () => void } {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id ?? "");
  const version = useEnvironmentsStore((s) => s.version);
  const [tick, setTick] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const key = workspaceId ? JSON.stringify([workspaceId, scope.kind, scope.id, version, tick]) : "";
  const { kind, id } = scope;

  useEffect(() => {
    if (!key) return;
    let live = true;
    api.overlayValues({ kind, id }).then(
      (values) => live && setAnswer({ key, values }),
      // Without an answer there's nothing to badge.
      () => live && setAnswer({ key, values: NONE }),
    );
    return () => {
      live = false;
    };
  }, [key, kind, id]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // The previous answer stays until the next one arrives, so badges don't flicker.
  return { values: key && answer ? answer.values : NONE, refresh };
}
