import { useState } from "react";
import { BookmarkPlus, ShieldAlert } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useExamplesStore } from "@/stores/examples";
import type { Tab } from "@/stores/tabs";
import { saveExampleState } from "./saveState";

/**
 * "Save as example" in the response header. When saving isn't possible it
 * stays focusable (aria-disabled) so the tooltip can say why.
 */
export function SaveExampleButton({ tab }: { tab: Tab }) {
  const state = saveExampleState(tab);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Save as example"
            aria-disabled={!state.ok}
            className={state.ok ? undefined : "opacity-50"}
            onClick={() => state.ok && setOpen(true)}
          >
            <BookmarkPlus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{state.ok ? "Save as example" : state.reason}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && state.ok && (
          <SaveExampleDialog tabId={tab.id} defaultName={state.defaultName} onDone={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}

function SaveExampleDialog({
  tabId,
  defaultName,
  onDone,
}: {
  tabId: string;
  defaultName: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  /** Names of secrets whose values are in the response: ask before saving. */
  const [secrets, setSecrets] = useState<string[] | null>(null);

  const save = async (replaceSecrets: boolean) => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const out = await useExamplesStore.getState().save(tabId, name.trim(), replaceSecrets);
    setBusy(false);
    if (out.status === "saved") onDone();
    else if (out.status === "secrets") setSecrets(out.names);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  if (secrets)
    return <SecretWarning names={secrets} busy={busy} onReplace={() => void save(true)} onCancel={onDone} />;

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Save as example</DialogTitle>
        <DialogDescription>
          The response is kept with the request, in an examples file next to it. Variables stay as written.
        </DialogDescription>
      </DialogHeader>
      <form id="save-example-form" onSubmit={submit} className="flex flex-col gap-1.5">
        <Label htmlFor="example-name">Name</Label>
        <Input
          id="example-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form="save-example-form" disabled={busy || !name.trim()}>
          Save example
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const ref = (name: string) => `{{${name}}}`;

/** Asked when the response holds a secret's value: save with {{name}} instead, or cancel. */
function SecretWarning({
  names,
  busy,
  onReplace,
  onCancel,
}: {
  names: string[];
  busy: boolean;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const more = names.length - 1;
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert aria-hidden className="size-4 text-status-client" />
          The response contains a secret
        </DialogTitle>
        <DialogDescription>
          This response contains the value of{" "}
          <code className="font-mono text-foreground">{ref(names[0])}</code>
          {more > 0 && ` (and ${more} more)`}. Examples are saved in the workspace and may be committed.
        </DialogDescription>
      </DialogHeader>
      {more > 0 && (
        <ul aria-label="Secrets found" className="flex flex-wrap gap-1.5">
          {names.map((n) => (
            <li key={n} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
              {ref(n)}
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button autoFocus disabled={busy} onClick={onReplace}>
          {more > 0 ? "Save with {{variables}} instead" : `Save with ${ref(names[0])} instead`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
