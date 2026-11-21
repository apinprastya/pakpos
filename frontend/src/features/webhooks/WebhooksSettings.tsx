import { useEffect } from "react";
import { Download, FileSearch, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/webhookModel";
import { useWebhooksStore } from "@/stores/webhooks";
import { CLOUDFLARED_DOCS } from "./CloudflaredPanel";

const SOURCES: Record<string, string> = {
  settings: "Chosen by you",
  downloaded: "Downloaded by Pakpos",
  path: "Found on your PATH",
};

/** Settings → Webhooks: which cloudflared public tunnels use. Changes apply right away. */
export function WebhooksSettings() {
  const cf = useWebhooksStore((s) => s.cloudflared);
  const install = useWebhooksStore((s) => s.install);
  const store = useWebhooksStore.getState;

  useEffect(() => {
    void useWebhooksStore.getState().checkCloudflared();
  }, []);

  const pct = install.total > 0 ? Math.min(100, Math.round((install.done / install.total) * 100)) : 0;
  return (
    <section aria-label="Webhooks" className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">Public tunnels</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Webhooks open a public URL with Cloudflare&apos;s free quick tunnels, through the cloudflared
          program. No account is needed. The URL changes every time a webhook starts. Changes here apply right
          away.
        </p>
      </div>
      {!cf ? (
        <p className="text-xs text-muted-foreground">Looking for cloudflared…</p>
      ) : cf.found ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">cloudflared</dt>
          <dd className="font-mono text-xs leading-5 break-all">{cf.path}</dd>
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono text-xs leading-5">{cf.version || "Unknown"}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{SOURCES[cf.source] ?? cf.source}</dd>
        </dl>
      ) : (
        <p role="status" className="text-sm">
          cloudflared isn&apos;t installed.{" "}
          <span className="text-muted-foreground">
            {cf.customPath ? cf.error : "Download it, or choose the file if you already have it."}
          </span>
        </p>
      )}
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
          <Button type="button" size="sm" variant="outline" onClick={() => void store().cancelInstall()}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {cf?.canDownload && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void store().installCloudflared()}
            >
              <Download /> {cf.source === "downloaded" ? "Update cloudflared" : "Download cloudflared"}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => void store().pickCloudflared()}>
            <FileSearch /> Choose file…
          </Button>
          {cf?.customPath && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void store().setCloudflaredPath("")}
            >
              <RotateCcw /> Find it automatically
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Downloads come from cloudflare/cloudflared on GitHub and are checked against their published SHA-256
        checksum. To install it with your package manager instead, see{" "}
        <a href={CLOUDFLARED_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          Cloudflare&apos;s download page
        </a>
        .
      </p>
    </section>
  );
}
