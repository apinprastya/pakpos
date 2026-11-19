import { RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OverlayValue } from "@/lib/model";
import { MASK } from "@/lib/variables";

const BADGE: Record<OverlayValue["state"], string> = {
  set: "Set by script",
  new: "New, set by script",
  unset: "Unset by script",
};

/** Under a variable's value: what a script set it to this session, with Reset and Persist. */
export function ScriptValueNote({
  value,
  onReset,
  onPersist,
}: {
  value: OverlayValue;
  onReset: () => void;
  onPersist: () => void;
}) {
  const shown = value.secret ? MASK : value.value;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 pb-0.5 text-[11px] text-muted-foreground">
      <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-primary">{BADGE[value.state]}</span>
      {value.state !== "unset" && (
        <span
          className="selectable min-w-0 truncate font-mono text-foreground"
          title={value.secret ? undefined : shown}
        >
          {shown === "" ? <span className="text-muted-foreground">(empty)</span> : shown}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1"
          aria-label={`Reset the script value of ${value.key}`}
          title="Use the file's value again"
          onClick={onReset}
        >
          <RotateCcw /> Reset
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1"
          aria-label={`Persist the script value of ${value.key} to the file`}
          title={value.secret ? "Store the value on this machine" : "Write the value to the workspace file"}
          onClick={onPersist}
        >
          <Save /> Persist to file
        </Button>
      </span>
    </div>
  );
}

/** Above the table when scripts set values in this scope. */
export function ScriptValuesBar({ count, onResetAll }: { count: number; onResetAll: () => void }) {
  if (count === 0) return null;
  return (
    <div role="note" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        Scripts set {count === 1 ? "1 value" : `${count} values`} here this session. They win over the file
        until you reset them or the workspace closes.
      </span>
      <Button variant="outline" size="xs" className="ml-auto shrink-0" onClick={onResetAll}>
        <RotateCcw /> Reset all script values
      </Button>
    </div>
  );
}
