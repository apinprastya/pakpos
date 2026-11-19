import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Auth } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useOAuth2Store } from "@/stores/oauth2";
import { useSecretsStore } from "@/stores/secrets";
import { tokenSummary } from "./oauth2";

interface Props {
  /** The request, folder or collection id that owns the token ("" for an unsaved request). */
  ownerId: string;
  /** A draft request's collection or folder, for {{variables}}. */
  parentId: string;
  /** The auth as edited (used to get or refresh a token); omit for a read-only view. */
  auth?: Auth;
}

/** Re-renders every 30 s so "valid until … (in 5 min)" stays current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The owner's OAuth 2.0 token: its state, and Get new access token, Refresh,
 * Clear and Reveal. Values never come from Go unless the user reveals them.
 */
export function OAuth2Token({ ownerId, parentId, auth }: Props) {
  const status = useOAuth2Store((s) => s.statuses[ownerId]);
  const flow = useOAuth2Store((s) => s.flows[ownerId]);
  const error = useOAuth2Store((s) => s.errors[ownerId]);
  const busy = useOAuth2Store((s) => s.busy[ownerId] ?? false);
  // A revealed token belongs to the owner it was read for.
  const [shown, setShown] = useState<{ owner: string; value: string } | null>(null);
  const revealed = shown?.owner === ownerId ? shown.value : null;
  const setRevealed = (value: string | null) => setShown(value === null ? null : { owner: ownerId, value });
  const now = useNow();

  useEffect(() => {
    void useOAuth2Store.getState().load(ownerId);
  }, [ownerId]);

  if (!ownerId) {
    return (
      <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        Save the request to get an access token. Its token is stored with it, in the secret store.
      </p>
    );
  }

  const store = useOAuth2Store.getState();
  const summary = tokenSummary(status, now);
  const readOnly = !auth;
  const has = status?.hasToken ?? false;

  const unlock = async () => {
    if (await useSecretsStore.getState().ensureReady()) await store.load(ownerId);
  };
  const reveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setRevealed(await store.reveal(ownerId));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(flow!.authUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link", { description: "The clipboard isn't available." });
    }
  };

  return (
    <section aria-label="Access token" className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <KeyRound aria-hidden className="size-3.5 text-muted-foreground" />
        <span
          role="status"
          className={cn(
            summary.tone === "valid" && "text-status-ok",
            summary.tone === "expired" && "text-status-client",
            (summary.tone === "none" || summary.tone === "locked") && "text-muted-foreground",
          )}
        >
          {summary.text}
        </span>
        {has && status!.scope && <span className="text-muted-foreground">Scope: {status!.scope}</span>}
        {has && status!.hasRefreshToken && <span className="text-muted-foreground">Can be refreshed.</span>}
      </div>

      {has && revealed !== null && (
        <p className="selectable rounded-sm bg-muted px-2 py-1 font-mono text-[12px] break-all">{revealed}</p>
      )}

      {flow && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          {flow.authUrl ? "Waiting for you to sign in in the browser…" : "Getting an access token…"}
          {flow.authUrl && (
            <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs" onClick={copy}>
              <Copy /> Copy the link
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!readOnly &&
          (flow ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void store.cancel(ownerId)}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void store.start(ownerId, parentId, auth!)}
            >
              Get new access token
            </Button>
          ))}
        {!readOnly && has && status!.hasRefreshToken && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !!flow}
            onClick={() => void store.refresh(ownerId, parentId, auth!)}
          >
            <RefreshCw /> Refresh
          </Button>
        )}
        {has && (
          <Button type="button" size="sm" variant="ghost" aria-pressed={revealed !== null} onClick={reveal}>
            {revealed !== null ? <EyeOff /> : <Eye />} {revealed !== null ? "Hide" : "Reveal"}
          </Button>
        )}
        {!readOnly && has && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!!flow}
            onClick={() => {
              setRevealed(null);
              void store.clear(ownerId);
            }}
          >
            <Trash2 /> Clear
          </Button>
        )}
        {status?.locked && (
          <Button type="button" size="sm" variant="outline" onClick={() => void unlock()}>
            Unlock
          </Button>
        )}
      </div>
    </section>
  );
}
