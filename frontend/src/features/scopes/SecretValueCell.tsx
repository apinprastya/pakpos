import { useRef, useState } from "react";
import { toast } from "sonner";
import { Eraser, Eye, EyeOff, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { ScopeRef } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useSecretsStore } from "@/stores/secrets";

const iconButtonClass =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

interface Props {
  scope: ScopeRef;
  keyName: string;
  /** Row number, for accessible names. */
  n: number;
  /** The key is saved as a secret in the workspace (so Go can reveal it). */
  saved: boolean;
  /** Whether a value is stored on this machine; null when the store is locked. */
  isSet: boolean | null;
  /** A value was stored (true) or cleared (false). */
  onStored: (set: boolean) => void;
}

/**
 * The value cell of a secret variable: masked, with reveal, set and clear.
 * A revealed value lives only in this component's state and is dropped when
 * hidden, when the key changes, or when the cell unmounts (leaving the tab).
 */
export function SecretValueCell({ scope, keyName, n, saved, isSet, onStored }: Props) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState(keyName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const name = keyName || `variable ${n}`;

  // Never keep a value around for a different key: drop it as soon as the key changes.
  if (revealedKey !== keyName) {
    setRevealedKey(keyName);
    setRevealed(null);
  }

  const ready = () => useSecretsStore.getState().ensureReady();

  const reveal = async () => {
    if (!(await ready())) return;
    try {
      setRevealed(await api.revealSecret(scope, keyName));
    } catch (e) {
      toast.error(`Couldn't show the value of ${name}`, { description: errorMessage(e) });
    }
  };

  const startEdit = () => {
    if (!keyName) {
      toast.error("Name the variable before setting its value");
      return;
    }
    done.current = false;
    setDraft("");
    setRevealed(null);
    setEditing(true);
  };

  const finishEdit = async (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = draft;
    setEditing(false);
    setDraft("");
    if (!commit || value === "") return;
    setBusy(true);
    try {
      if (!(await ready())) return;
      await api.setSecret(scope, keyName, value);
      onStored(true);
    } catch (e) {
      toast.error(`Couldn't store the value of ${name}`, { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    try {
      if (!(await ready())) return;
      await api.clearSecret(scope, keyName);
      setRevealed(null);
      onStored(false);
    } catch (e) {
      toast.error(`Couldn't clear the value of ${name}`, { description: errorMessage(e) });
    }
  };

  if (editing) {
    return (
      <input
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        aria-label={`New value for ${name}`}
        placeholder="Type the value, then press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void finishEdit(true);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            void finishEdit(false);
          }
        }}
        onBlur={() => void finishEdit(true)}
        className="h-7 w-full min-w-0 rounded-sm bg-card px-2 font-mono text-[12.5px] ring-1 ring-ring outline-none placeholder:text-muted-foreground/60"
      />
    );
  }

  let text: React.ReactNode;
  if (revealed !== null) {
    text = <span className="selectable truncate font-mono text-[12.5px]">{revealed || "(empty)"}</span>;
  } else if (busy) {
    text = <span className="text-xs text-muted-foreground">Saving…</span>;
  } else if (isSet === null) {
    text = (
      <button
        type="button"
        onClick={() => useSecretsStore.getState().openDialog("unlock")}
        className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Locked. Unlock to use it
      </button>
    );
  } else if (isSet) {
    text = (
      <span
        aria-label="Value hidden"
        className="font-mono text-[12.5px] tracking-widest text-muted-foreground"
      >
        ••••••••
      </span>
    );
  } else {
    text = <span className="text-xs text-muted-foreground italic">Not set on this machine</span>;
  }

  const canReveal = saved && isSet !== false;
  return (
    <div className="flex h-7 min-w-0 items-center gap-0.5 pl-2">
      <span className="flex min-w-0 flex-1 items-center">{text}</span>
      {canReveal && (
        <button
          type="button"
          aria-label={revealed !== null ? `Hide value of ${name}` : `Show value of ${name}`}
          aria-pressed={revealed !== null}
          title={revealed !== null ? "Hide value" : "Show value"}
          onClick={() => (revealed !== null ? setRevealed(null) : void reveal())}
          className={iconButtonClass}
        >
          {revealed !== null ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
      <button
        type="button"
        aria-label={isSet ? `Change value of ${name}` : `Set value of ${name}`}
        title={isSet ? "Change value" : "Set value"}
        onClick={startEdit}
        className={iconButtonClass}
      >
        <Pencil className="size-3.5" />
      </button>
      {isSet !== false && (
        <button
          type="button"
          aria-label={`Clear value of ${name}`}
          title="Clear value"
          onClick={() => void clear()}
          className={cn(iconButtonClass)}
        >
          <Eraser className="size-3.5" />
        </button>
      )}
    </div>
  );
}
