import { create } from "zustand";
import { statusName, type ConsoleEntry, type ConsoleLevel, type SendResult } from "@/lib/model";

/** The most console lines kept; the oldest go first. */
export const MAX_CONSOLE_ENTRIES = 2000;

/** A console line with an id (for keys and copying). Secret values are already masked by Go. */
export interface ConsoleLine extends ConsoleEntry {
  id: number;
}

/** The console output of one send, under a header. */
export interface ConsoleGroup {
  sendId: string;
  /** When the send started (ms since the epoch). */
  startedAt: number;
  method: string;
  name: string;
  /** "200 OK", "Error", "Skipped", or "" while sending. */
  status: string;
  /** The send has finished: its lines are final, late events are ignored. */
  done: boolean;
  lines: ConsoleLine[];
  /** Where the send came from when not a tab, e.g. "Run API · Iteration 2". */
  context?: string;
}

/** A finished send of a collection run, added in one go. */
export interface RunSendMeta extends SendMeta {
  context: string;
  status: string;
  startedAt: number;
}

export interface SendMeta {
  method: string;
  name: string;
}

/**
 * The script console: output of each send, grouped. In memory only (never
 * persisted), capped at MAX_CONSOLE_ENTRIES lines. Lines arrive live through
 * the `script:console` event (`append`) and are replaced by the send's final
 * `SendResult.console` when it finishes (`finish`), so nothing is shown twice.
 */
interface ConsoleState {
  open: boolean;
  groups: ConsoleGroup[];
  /** Lines added while the drawer was closed. */
  unread: number;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  begin: (sendId: string, meta: SendMeta) => void;
  append: (sendId: string, entries: ConsoleEntry[]) => void;
  finish: (sendId: string, result: SendResult) => void;
  /** Adds a finished runner send's lines under their own header (nothing when there are none). */
  addRunSend: (sendId: string, meta: RunSendMeta, entries: ConsoleEntry[]) => void;
  clear: () => void;
}

let nextId = 1;
const withIds = (entries: ConsoleEntry[]): ConsoleLine[] => entries.map((e) => ({ ...e, id: nextId++ }));

/** Drops the oldest lines past the cap, and groups left empty once they're done. */
function capped(groups: ConsoleGroup[]): ConsoleGroup[] {
  let total = groups.reduce((n, g) => n + g.lines.length, 0);
  if (total <= MAX_CONSOLE_ENTRIES) return groups;
  const out: ConsoleGroup[] = [];
  for (const g of groups) {
    if (total > MAX_CONSOLE_ENTRIES && g.lines.length > 0) {
      const drop = Math.min(g.lines.length, total - MAX_CONSOLE_ENTRIES);
      total -= drop;
      const lines = g.lines.slice(drop);
      if (lines.length > 0 || !g.done) out.push({ ...g, lines });
    } else {
      out.push(g);
    }
  }
  return out;
}

/** The status shown in a group's header. */
export function statusText(result: SendResult): string {
  if (result.skipped) return "Skipped";
  if (result.error) return result.error.kind === "canceled" ? "Cancelled" : "Error";
  if (result.response) return statusName(result.response.statusCode, result.response.statusText);
  return "";
}

/** A pre-request script error as a console line, so the console shows script errors too. */
function errorLine(result: SendResult): ConsoleEntry[] {
  if (result.error?.kind !== "script" || !result.scriptError) return [];
  return [{ level: "error", text: result.error.message, source: result.scriptError.source }];
}

export const useConsoleStore = create<ConsoleState>()((set, get) => ({
  open: false,
  groups: [],
  unread: 0,

  toggle: () => get().setOpen(!get().open),
  setOpen: (open) => set(open ? { open, unread: 0 } : { open }),

  begin: (sendId, meta) =>
    set((s) => ({
      groups: capped([
        ...s.groups.filter((g) => g.sendId !== sendId),
        {
          sendId,
          startedAt: Date.now(),
          method: meta.method,
          name: meta.name,
          status: "",
          done: false,
          lines: [],
        },
      ]),
    })),

  append: (sendId, entries) => {
    if (entries.length === 0) return;
    const group = get().groups.find((g) => g.sendId === sendId);
    if (!group || group.done) return;
    set((s) => ({
      groups: capped(
        s.groups.map((g) => (g.sendId === sendId ? { ...g, lines: [...g.lines, ...withIds(entries)] } : g)),
      ),
      unread: s.open ? 0 : s.unread + entries.length,
    }));
  },

  finish: (sendId, result) => {
    const group = get().groups.find((g) => g.sendId === sendId);
    if (!group) return;
    const entries = [...result.console, ...errorLine(result)];
    const added = Math.max(0, entries.length - group.lines.length);
    set((s) => ({
      // A send that logged nothing leaves no header behind.
      groups: capped(
        s.groups.flatMap((g) =>
          g.sendId !== sendId
            ? [g]
            : entries.length === 0
              ? []
              : [{ ...g, status: statusText(result), done: true, lines: withIds(entries) }],
        ),
      ),
      unread: s.open ? 0 : s.unread + added,
    }));
  },

  addRunSend: (sendId, meta, entries) => {
    if (entries.length === 0) return;
    set((s) => ({
      groups: capped([
        ...s.groups.filter((g) => g.sendId !== sendId),
        {
          sendId,
          startedAt: meta.startedAt,
          method: meta.method,
          name: meta.name,
          status: meta.status,
          done: true,
          lines: withIds(entries),
          context: meta.context,
        },
      ]),
      unread: s.open ? 0 : s.unread + entries.length,
    }));
  },

  clear: () => set({ groups: [], unread: 0 }),
}));

/** Levels in display order (the filter). */
export const CONSOLE_LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
