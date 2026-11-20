import { useEffect, useMemo, useState } from "react";
import { Clock, Copy, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ToolProps } from "../registry";
import type { TimestampState } from "./state";
import {
  convertTimestamp,
  systemZone,
  timeZones,
  validZone,
  type OutputRow,
  type UnitOverride,
} from "./timestamp";

/** How often the relative time ("3 min ago") refreshes. */
const TICK_MS = 15_000;

const UNITS: { id: UnitOverride; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "s", label: "Seconds" },
  { id: "ms", label: "Milliseconds" },
  { id: "us", label: "Microseconds" },
  { id: "ns", label: "Nanoseconds" },
];

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The timestamp converter: one input, read in any supported format, written in all of them. */
export function TimestampTool({ tabId, state, update }: ToolProps<TimestampState>) {
  const now = useNow();
  const zone = validZone(state.zone);
  const zones = useMemo(() => timeZones([systemZone(), zone]), [zone]);
  const result = useMemo(
    () => convertTimestamp(state.input, { unit: state.unit, zone, now }),
    [state.input, state.unit, zone, now],
  );
  const set = (patch: Partial<TimestampState>) => update((s) => ({ ...s, ...patch }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Clock aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Timestamp converter</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${tabId}-unit`} className="text-xs font-normal text-muted-foreground">
            Read numbers as
          </Label>
          <Select value={state.unit} onValueChange={(v) => set({ unit: v as UnitOverride })}>
            <SelectTrigger id={`${tabId}-unit`} size="sm" className="w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${tabId}-zone`} className="text-xs font-normal text-muted-foreground">
            Time zone
          </Label>
          <Select value={zone} onValueChange={(v) => set({ zone: v === systemZone() ? "" : v })}>
            <SelectTrigger id={`${tabId}-zone`} size="sm" className="w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z === systemZone() ? `${z} (this computer)` : z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Input" className="flex flex-col gap-1.5 border-b px-3 py-3">
          <Label htmlFor={`${tabId}-input`} className="text-xs font-medium text-muted-foreground">
            Timestamp
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              id={`${tabId}-input`}
              value={state.input}
              onChange={(e) => set({ input: e.target.value })}
              autoFocus={state.input === ""}
              spellCheck={false}
              autoComplete="off"
              placeholder="1700000000, 2026-11-20T12:00:00Z or Sun, 06 Nov 1994 08:49:37 GMT"
              className="h-8 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => set({ input: String(Math.floor(Date.now() / 1000)) })}
            >
              <Timer /> Now
            </Button>
            <IconButton
              label="Clear timestamp"
              disabled={state.input === ""}
              onClick={() => set({ input: "" })}
            >
              <X />
            </IconButton>
          </div>
          {result.kind === "ok" && <p className="text-xs text-muted-foreground">{result.detected}.</p>}
          {result.kind === "error" && (
            <p role="alert" className="text-xs text-destructive">
              {result.message}
            </p>
          )}
        </section>
        {result.kind === "ok" ? (
          <Results rows={result.rows} />
        ) : (
          result.kind === "empty" && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Type or paste a timestamp, or press Now. Every format shows here.
            </p>
          )
        )}
      </div>
    </div>
  );
}

function Results({ rows }: { rows: OutputRow[] }) {
  return (
    <section aria-label="Formats">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b align-middle">
              <th
                scope="row"
                className="w-52 py-1.5 pr-2 pl-3 text-left text-xs font-normal text-muted-foreground"
              >
                {r.label}
              </th>
              <td className={r.mono ? "py-1.5 font-mono text-xs break-all" : "py-1.5 text-sm"}>{r.value}</td>
              <td className="w-10 pr-1.5 text-right">
                <IconButton label={`Copy ${r.label}`} onClick={() => void copy(r.value, r.label)}>
                  <Copy />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy", { description: "The clipboard isn't available." });
  }
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
