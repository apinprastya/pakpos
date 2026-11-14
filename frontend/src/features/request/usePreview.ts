import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { compactRequest, type Request, type ResolvePreview } from "@/lib/model";
import { useEnvironmentsStore } from "@/stores/environments";
import { useWorkspaceStore } from "@/stores/workspace";

export const PREVIEW_DEBOUNCE_MS = 300;

export interface PreviewState {
  preview: ResolvePreview | null;
  loading: boolean;
  error: string | null;
}

interface Answer {
  /** What the answer is for: the request, its parent and the variables version. */
  key: string;
  preview: ResolvePreview | null;
  error: string | null;
}

/**
 * How the request resolves (inherited headers and auth, variables), from Go's
 * `ResolvePreview`. Refreshed on a debounce when the draft, its parent, the
 * selected environment or any variables or inherited settings change. Null
 * without a workspace. Never holds secret values.
 */
export function usePreview(request: Request, parentId: string): PreviewState {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id ?? "");
  const collections = useWorkspaceStore((s) => s.collections);
  const version = useEnvironmentsStore((s) => s.version);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const body = workspaceId ? JSON.stringify(compactRequest(request)) : "";
  const key = body ? `${workspaceId}\n${parentId}\n${version}\n${body}` : "";

  useEffect(() => {
    if (!key) return;
    let live = true;
    const timer = setTimeout(() => {
      api.resolvePreview(JSON.parse(body) as Request, parentId).then(
        (preview) => live && setAnswer({ key, preview, error: null }),
        (e: unknown) =>
          live && setAnswer({ key, preview: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `collections` re-runs the preview after tree changes (moves change what's inherited).
  }, [key, body, parentId, collections]);

  if (!key) return { preview: null, loading: false, error: null };
  // Keep showing the last answer while a newer one is on its way.
  return { preview: answer?.preview ?? null, loading: answer?.key !== key, error: answer?.error ?? null };
}
