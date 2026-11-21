import { useEffect } from "react";
import { Download, FileSearch, Globe, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/webhookModel";
import { useWebhooksStore } from "@/stores/webhooks";

export const CLOUDFLARED_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/**
 * Shown when a public tunnel needs cloudflared and it isn't found: download
 * it (checked against GitHub's SHA-256), choose the file, or start local only.
 */
export function CloudflaredPanel({
  onReady,
  onLocalOnly,
  onDismiss,
}: {
  /** Called once cloudflared is found (after a download or a pick). */
  onReady: () => void;
  onLocalOnly: () => void;
  onDismiss: () => void;
}) {
  const cf = useWebhooksStore((s) => s.cloudflared);
  const install = useWebhooksStore((s) => s.install);
  const store = useWebhooksStore.getState;

  useEffect(() => {
    if (cf?.found) onReady();
  }, [cf?.found, onReady]);

  const pct = install.total > 0 ? Math.min(100, Math.round((install.done / install.total) * 100)) : 0;
  return (
    <section
      aria-label="cloudflared is needed"
      className="mx-4 mt-3 flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <Globe aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium">Pakpos needs cloudflared to open a public tunnel.</p>
          <p className="text-xs text-muted-foreground">
            cloudflared is Cloudflare&apos;s free tunnel program. Pakpos can download the latest release from
            GitHub and checks it against its published SHA-256 checksum. No Cloudflare account is needed.
          </p>
          {cf?.error && cf.customPath && <p className="text-xs text-destructive">{cf.error}</p>}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onDismiss}>
          <X />
        </Button>
      </div>
      {install.running ? (
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Downloading cloudflared"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {install.total > 0 ? `${formatSize(install.done)} of ${formatSize(install.total)}` : "Starting…"}
          </span>
          <Button size="sm" variant="outline" onClick={() => void store().cancelInstall()}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {cf?.canDownload !== false && (
            <Button size="sm" onClick={() => void store().installCloudflared()}>
              <Download /> Download cloudflared
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void store().pickCloudflared()}>
            <FileSearch /> Choose file…
          </Button>
          <Button size="sm" variant="ghost" onClick={onLocalOnly}>
            <Play /> Start local only
          </Button>
          <a
            href={CLOUDFLARED_DOCS}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Install it yourself
          </a>
        </div>
      )}
    </section>
  );
}
