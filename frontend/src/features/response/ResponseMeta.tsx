import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { Response } from "@/lib/model";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, statusTextClass } from "./format";

/** Status, time (with a phase breakdown on hover) and size. */
export function ResponseMeta({ response }: { response: Response }) {
  const t = response.timings;
  const phases = [
    { label: "DNS lookup", ms: t.dns },
    { label: "Connect", ms: t.connect },
    { label: "TLS handshake", ms: t.tls },
    { label: "Waiting for first byte", ms: t.ttfb },
  ];
  const statusLabel = response.statusText || String(response.statusCode);

  return (
    <div className="flex items-center gap-3 text-xs">
      <span
        aria-label={`Status ${statusLabel}`}
        className={cn("font-mono font-semibold", statusTextClass(response.statusCode))}
      >
        {statusLabel}
      </span>
      <HoverCard openDelay={150} closeDelay={50}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`Time ${formatDuration(t.total)}, show breakdown`}
            className="rounded-sm text-muted-foreground tabular-nums underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {formatDuration(t.total)}
          </button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-64 text-xs">
          <p className="mb-2 font-medium">Where the time went</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            {phases.map((p) => (
              <Phase key={p.label} label={p.label} ms={p.ms} total={t.total} />
            ))}
            <dt className="border-t pt-1 font-medium">Total</dt>
            <dd className="border-t pt-1 text-right font-medium tabular-nums">{formatDuration(t.total)}</dd>
          </dl>
          {t.reusedConn && (
            <p className="mt-2 text-muted-foreground">
              Reused an open connection, so there was no DNS, connect or TLS.
            </p>
          )}
        </HoverCardContent>
      </HoverCard>
      <span className="text-muted-foreground tabular-nums" title={`${response.size.toLocaleString()} bytes`}>
        {formatBytes(response.size)}
      </span>
    </div>
  );
}

function Phase({ label, ms, total }: { label: string; ms: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (ms / total) * 100) : 0;
  return (
    <>
      <dt className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span aria-hidden className="h-1 rounded-full bg-muted">
          <span className="block h-1 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
      </dt>
      <dd className="text-right text-muted-foreground tabular-nums">{ms > 0 ? formatDuration(ms) : "—"}</dd>
    </>
  );
}
