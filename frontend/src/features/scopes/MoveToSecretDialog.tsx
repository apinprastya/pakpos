import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { moveToSecret, scopeOptions, variableNameError, type ScopeOption } from "./moveToSecret";

interface Props {
  /** The literal value to move, or null when closed. */
  value: string | null;
  suggestedName: string;
  /** Collection the request or settings belong to ("" for none). */
  collectionId: string;
  /** Called with the new variable's name once the value is stored. */
  onMoved: (name: string) => void;
  onClose: () => void;
}

/** "Move to secret variable": asks for a name and a scope, stores the value as a secret. */
export function MoveToSecretDialog({ value, suggestedName, collectionId, onMoved, onClose }: Props) {
  return (
    <Dialog open={value !== null} onOpenChange={(open) => !open && onClose()}>
      {value !== null && (
        <MoveBody
          value={value}
          suggestedName={suggestedName}
          collectionId={collectionId}
          onMoved={onMoved}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function MoveBody({ value, suggestedName, collectionId, onMoved, onClose }: Props & { value: string }) {
  const nameId = useId();
  const scopeId = useId();
  const [options] = useState(() => scopeOptions(collectionId));
  const [name, setName] = useState(suggestedName);
  const [target, setTarget] = useState<ScopeOption["value"]>(options[0].value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    const problem = variableNameError(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    const option = options.find((o) => o.value === target)!;
    setBusy(true);
    try {
      if (await moveToSecret(option.scope, option.label, trimmed, value)) {
        onMoved(trimmed);
        toast.success(`Moved to the secret variable {{${trimmed}}}`, { description: option.label });
        onClose();
        return;
      }
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Move to secret variable</DialogTitle>
          <DialogDescription>
            The value is stored on this machine only, and the field becomes a {"{{variable}}"} reference, so
            the file no longer contains it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>Variable name</Label>
          <Input
            id={nameId}
            className="font-mono"
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={scopeId}>Store in</Label>
          <Select value={target} onValueChange={(v) => setTarget(v as ScopeOption["value"])}>
            <SelectTrigger id={scopeId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Moving…" : "Move to secret"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
