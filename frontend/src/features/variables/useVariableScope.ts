import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { EnvRef, PreviewVariable, ScopeKind } from "@/lib/model";
import { makeScope, overlayDraft, scopeSignature, type VarScope } from "@/lib/variables";
import { useEnvironmentsStore } from "@/stores/environments";
import type { Tab } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import type { PreviewState } from "@/features/request/usePreview";

export const VISIBLE_DEBOUNCE_MS = 300;

interface Source {
  /** Collection or folder the variables are seen from ("" for none). */
  parentId: string;
  /** Environment to use ("" for the selected one). */
  environmentId: string;
  /** The scope edited in this tab, whose unsaved rows apply over disk. */
  target: { kind: ScopeKind; id: string; name: string } | null;
}

/** Where a settings tab sees variables from. Request tabs use their preview instead. */
function sourceOf(tab: Tab): Source | null {
  const doc = tab.doc;
  if (!doc) return null;
  switch (doc.kind) {
    case "environment":
      return {
        parentId: "",
        environmentId: doc.targetId,
        target: { kind: "environment", id: doc.targetId, name: doc.name },
      };
    case "globals":
      return { parentId: "", environmentId: "", target: { kind: "global", id: "", name: "Globals" } };
    case "collection":
      return {
        parentId: doc.targetId,
        environmentId: "",
        target: { kind: "collection", id: doc.targetId, name: doc.name },
      };
    default:
      return { parentId: doc.targetId, environmentId: "", target: null };
  }
}

interface Answer {
  key: string;
  variables: PreviewVariable[];
  environment: EnvRef | null;
}

/** `EnvService.VisibleVariables` on a debounce; refreshed like `usePreview`. Off when source is null. */
function useVisible(source: Source | null): Answer | null {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id ?? "");
  const collections = useWorkspaceStore((s) => s.collections);
  const version = useEnvironmentsStore((s) => s.version);
  const selectedId = useEnvironmentsStore((s) => s.selectedId);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const key =
    source && workspaceId
      ? [workspaceId, source.parentId, source.environmentId, selectedId, version].join("\n")
      : "";

  useEffect(() => {
    if (!key || !source) return;
    let live = true;
    const timer = setTimeout(() => {
      api.visibleVariables(source.parentId, source.environmentId).then(
        (v) => live && setAnswer({ key, variables: v.variables, environment: v.environment }),
        // Without an answer, names stay unjudged rather than all marked unresolved.
        () => live && setAnswer({ key, variables: [], environment: null }),
      );
    }, VISIBLE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `collections` re-runs after tree changes (a moved folder sees another collection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, collections]);

  return key ? answer : null;
}

/**
 * The variables editors in a tab can reference, for highlighting, hover and
 * autocomplete. A request tab reuses its `usePreview` answer (one fetch per
 * tab); settings tabs ask Go for the variables visible from their scope and
 * apply their unsaved rows on top. The result keeps its identity until the
 * content changes, so editors and table rows don't re-render for nothing.
 */
export function useVariableScope(tab: Tab, preview?: PreviewState): VarScope {
  const hasWorkspace = useWorkspaceStore((s) => s.workspace !== null);
  const source = sourceOf(tab);
  const visible = useVisible(source);
  const draftRows = tab.doc?.draft?.variables;

  let variables: readonly PreviewVariable[] = [];
  let environment: EnvRef | null = null;
  let ready = !hasWorkspace;
  if (source) {
    if (visible) {
      variables = visible.variables;
      environment = visible.environment;
      ready = true;
    }
    if (source.target && draftRows) {
      variables = overlayDraft(variables, source.target, draftRows);
    }
  } else if (preview?.preview) {
    variables = preview.preview.variables;
    environment = preview.preview.environment;
    ready = true;
  } else if (preview?.error) {
    ready = true;
  }
  const signature = scopeSignature(variables, environment, hasWorkspace, ready);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeScope(variables, environment, hasWorkspace, ready), [signature]);
}
