import { useCallback, useEffect, useState } from "react";
import { FileUp, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { describeImport, importTarget, type ImportSummary, type ImportWarning } from "@/lib/importModel";
import { usePostmanImportStore } from "@/stores/postmanImport";
import { importPostmanFile } from "./actions";

type Step =
  | { state: "choose" }
  | { state: "loading"; path: string }
  | { state: "error"; path: string; message: string }
  | { state: "preview"; path: string; summary: ImportSummary; importing: boolean; importError?: string };

/** "Import from Postman": choose an exported file, check what it adds, import it. */
export function ImportPostmanDialog() {
  const open = usePostmanImportStore((s) => s.open);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && usePostmanImportStore.getState().close()}>
      {open && <ImportBody />}
    </Dialog>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function ImportBody() {
  const [step, setStep] = useState<Step>({ state: "choose" });
  // Bumped on every pick, so choosing the same file again reads it again.
  const [pick, setPick] = useState(0);
  const guessSecrets = usePostmanImportStore((s) => s.guessSecrets);
  const path = step.state === "choose" ? "" : step.path;

  // Preview the chosen file, again whenever the secrets option changes.
  useEffect(() => {
    if (!path) return;
    let current = true;
    api.previewPostman(path, { guessSecrets }).then(
      (summary) => current && setStep({ state: "preview", path, summary, importing: false }),
      (e: unknown) => current && setStep({ state: "error", path, message: errorMessage(e) }),
    );
    return () => {
      current = false;
    };
  }, [path, guessSecrets, pick]);

  const choose = useCallback(async () => {
    try {
      const picked = await api.pickPostmanFile();
      if (!picked) return;
      setStep({ state: "loading", path: picked });
      setPick((n) => n + 1);
    } catch (e) {
      setStep({ state: "error", path: "", message: errorMessage(e) });
    }
  }, []);

  const doImport = async () => {
    if (step.state !== "preview" || step.importing) return;
    const { summary } = step;
    setStep({ ...step, importing: true, importError: undefined });
    try {
      const res = await importPostmanFile(path, { guessSecrets }, summary);
      if (res) usePostmanImportStore.getState().close();
      else setStep({ ...step, importing: false });
    } catch (e) {
      setStep({ ...step, importing: false, importError: errorMessage(e) });
    }
  };

  const importing = step.state === "preview" && step.importing;
  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Import from Postman</DialogTitle>
        <DialogDescription>
          In Postman, export a collection (as Collection v2.1), an environment or your globals to a JSON file,
          then choose that file here.
        </DialogDescription>
      </DialogHeader>

      {path ? (
        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs">
          <FileUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono" title={path}>
            {fileName(path)}
          </span>
          <Button size="sm" variant="ghost" disabled={importing} onClick={() => void choose()}>
            Choose another file
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-4 py-8 text-center">
          <FileUp aria-hidden className="size-6 text-muted-foreground" />
          <Button size="sm" onClick={() => void choose()} autoFocus>
            Choose file…
          </Button>
        </div>
      )}

      {step.state === "loading" && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Reading the file…
        </p>
      )}
      {step.state === "error" && <ErrorLine message={step.message} />}
      {step.state === "preview" && (
        <Preview
          summary={step.summary}
          guessSecrets={guessSecrets}
          disabled={step.importing}
          onGuessSecrets={(on) => usePostmanImportStore.getState().setGuessSecrets(on)}
        />
      )}
      {step.state === "preview" && step.importError && <ErrorLine message={step.importError} />}

      <DialogFooter>
        <Button variant="outline" onClick={() => usePostmanImportStore.getState().close()}>
          Cancel
        </Button>
        <Button disabled={step.state !== "preview" || importing} onClick={() => void doImport()}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex gap-2 text-xs text-destructive">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      {message}
    </p>
  );
}

function Preview({
  summary,
  guessSecrets,
  disabled,
  onGuessSecrets,
}: {
  summary: ImportSummary;
  guessSecrets: boolean;
  disabled: boolean;
  onGuessSecrets: (on: boolean) => void;
}) {
  return (
    <section aria-label="Preview" aria-live="polite" className="min-w-0 space-y-3 text-xs">
      <div className="space-y-0.5">
        <p className="font-medium">{importTarget(summary)}</p>
        <p className="text-muted-foreground">{describeImport(summary)}</p>
        {summary.replaced.length > 0 && (
          <p className="text-muted-foreground">
            Replaces {summary.replaced.length === 1 ? "an existing global" : "existing globals"}:{" "}
            <span className="font-mono text-foreground">{summary.replaced.join(", ")}</span>
          </p>
        )}
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="postman-guess-secrets"
          checked={guessSecrets}
          disabled={disabled}
          onCheckedChange={(v) => onGuessSecrets(v === true)}
          aria-describedby="postman-guess-secrets-hint"
          className="mt-0.5"
        />
        <div>
          <label htmlFor="postman-guess-secrets" className="font-medium">
            Keep credentials in the secret store
          </label>
          <p id="postman-guess-secrets-hint" className="text-muted-foreground">
            Variables named like token, password or apiKey become secret variables, so their values stay out
            of workspace files. Postman&apos;s secret variables always do.
          </p>
        </div>
      </div>
      <Warnings warnings={summary.warnings} />
    </section>
  );
}

function Warnings({ warnings }: { warnings: ImportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="max-h-48 overflow-y-auto rounded-md border px-3 py-2 text-muted-foreground">
      <p className="flex items-center gap-2 font-medium text-foreground">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-client" />
        {warnings.length === 1 ? "1 thing to check" : `${warnings.length} things to check`}
      </p>
      <ul aria-label="Warnings" className="mt-1 list-disc space-y-1 pl-5">
        {warnings.map((w, i) => (
          <li key={i}>
            {w.where && <span className="font-medium text-foreground">{w.where}: </span>}
            {w.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
