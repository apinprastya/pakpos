import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { CollectionNode, ContainerNode, ScriptLevelKind, Scripts } from "@/lib/model";
import { ancestorsOf, findContainer } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import { useWorkspaceStore } from "@/stores/workspace";

/** A collection or folder above the edited item, with its scripts. */
export interface InheritedScript {
  kind: Exclude<ScriptLevelKind, "request">;
  id: string;
  name: string;
  scripts: Scripts;
}

/** A level whose scripts run before the edited item's: collection first. */
export interface Level {
  kind: Exclude<ScriptLevelKind, "request">;
  id: string;
  name: string;
}

/**
 * The collection and folders whose scripts run before an item's, outermost
 * first: for a request, its parent and everything above it; for a folder,
 * everything above it; a collection has none.
 */
export function levelsAbove(
  collections: CollectionNode[],
  item: { kind: ScriptLevelKind; id: string; parentId?: string },
): Level[] {
  let chain: ContainerNode[];
  if (item.kind === "request") {
    const parent = item.parentId ? findContainer(collections, item.parentId) : undefined;
    chain = parent ? [...ancestorsOf(collections, parent.kind, parent.id), parent] : [];
  } else if (item.kind === "folder") {
    chain = ancestorsOf(collections, "folder", item.id);
  } else {
    chain = [];
  }
  return chain.map((n) => ({ kind: n.kind, id: n.id, name: n.name }));
}

interface Answer {
  key: string;
  levels: InheritedScript[];
}

/**
 * The scripts of the levels above an item (see `levelsAbove`), read from Go.
 * Re-read when the chain changes or a collection or folder is saved
 * (`environments.version`). Levels that fail to load are left out.
 */
export function useInheritedScripts(item: {
  kind: ScriptLevelKind;
  id: string;
  parentId?: string;
}): InheritedScript[] {
  const collections = useWorkspaceStore((s) => s.collections);
  const version = useEnvironmentsStore((s) => s.version);
  const levels = useMemo(
    () => levelsAbove(collections, item),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collections, item.kind, item.id, item.parentId],
  );
  const key = levels.length
    ? `${version}\n${levels.map((l) => `${l.kind}:${l.id}:${l.name}`).join("\n")}`
    : "";
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    void Promise.all(
      levels.map(async (l): Promise<InheritedScript | null> => {
        try {
          const s = l.kind === "collection" ? await api.getCollection(l.id) : await api.getFolder(l.id);
          return { ...l, scripts: s.scripts };
        } catch {
          return null;
        }
      }),
    ).then((list) => {
      if (live) setAnswer({ key, levels: list.filter((l): l is InheritedScript => l !== null) });
    });
    return () => {
      live = false;
    };
    // `levels` is part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return key && answer?.key === key ? answer.levels : EMPTY;
}

const EMPTY: InheritedScript[] = [];
