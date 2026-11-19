import { useEffect, useId, useState } from "react";
import { Copy, Info, LoaderCircle, TriangleAlert } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { editorLanguage } from "@/components/editor/languages";
import { api } from "@/lib/api";
import { compactRequest, type CodeLanguage, type CodeResult, type Request } from "@/lib/model";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useEnvironmentsStore } from "@/stores/environments";
import { isRequestTab, tabTitle, useTabsStore } from "@/stores/tabs";
import { codeLanguages } from "./languages";
import { addedHeadersNote, codeNotes } from "./summary";

type Gen = { state: "ok"; result: CodeResult } | { state: "error"; message: string };

/**
 * "Generate code": the active request as code in the chosen language. Revealed
 * secrets live only in this dialog's state, which is dropped when it closes.
 */
export function CodeDialog() {
  const tabId = useCodeDialogsStore((s) => s.codeTabId);
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId && isRequestTab(t)));
  const open = !!tab;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && useCodeDialogsStore.getState().closeCode()}>
      {tab && <CodeBody key={tab.id} title={tabTitle(tab)} request={tab.request} parentId={tab.parentId} />}
    </Dialog>
  );
}

function CodeBody({ title, request, parentId }: { title: string; request: Request; parentId: string }) {
  const language = useCodeDialogsStore((s) => s.language);
  const envVersion = useEnvironmentsStore((s) => s.version);
  const [languages, setLanguages] = useState<CodeLanguage[] | null>(null);
  const [resolve, setResolve] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [langError, setLangError] = useState("");
  /** The last answer and the options it was for; a different key means a new one is on its way. */
  const [answer, setAnswer] = useState<{ key: string; gen: Gen } | null>(null);
  const ids = { resolve: useId(), reveal: useId(), revealNote: useId() };

  useEffect(() => {
    let current = true;
    codeLanguages().then(
      (list) => current && setLanguages(list),
      (e: unknown) => current && setLangError(messageOf(e)),
    );
    return () => {
      current = false;
    };
  }, []);

  const selected = languages?.find((l) => l.id === language) ?? languages?.[0];
  const langId = selected?.id ?? "";
  const revealing = resolve && reveal;

  const key = `${langId}|${resolve}|${revealing}|${envVersion}|${parentId}|${JSON.stringify(request)}`;
  useEffect(() => {
    if (!langId) return;
    let current = true;
    api
      .generateCode(compactRequest(request), parentId, langId, {
        resolveVariables: resolve,
        revealSecrets: revealing,
      })
      .then(
        (result) => current && setAnswer({ key, gen: { state: "ok", result } }),
        (e: unknown) => current && setAnswer({ key, gen: { state: "error", message: messageOf(e) } }),
      );
    return () => {
      current = false;
    };
  }, [key, request, parentId, langId, resolve, revealing]);

  const loading = !langError && answer?.key !== key;
  const gen: Gen | null = langError ? { state: "error", message: langError } : (answer?.gen ?? null);
  // While a new answer loads, the previous code stays visible under the overlay.
  const code = gen?.state === "ok" ? gen.result.code : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Code copied");
    } catch {
      toast.error("Couldn't copy the code", { description: "The clipboard isn't available." });
    }
  };

  return (
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Generate code</DialogTitle>
        <DialogDescription>
          {title} as code, with inherited auth and headers applied. It sends the request and prints the
          response.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Select
          value={langId}
          onValueChange={(id) => useCodeDialogsStore.getState().setLanguage(id)}
          disabled={!languages}
        >
          <SelectTrigger aria-label="Language" size="sm" className="w-60">
            <SelectValue placeholder="Loading…" />
          </SelectTrigger>
          <SelectContent>
            {(languages ?? []).map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id={ids.resolve} checked={resolve} onCheckedChange={setResolve} />
          <Label htmlFor={ids.resolve} className="font-normal">
            Resolve variables
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={ids.reveal}
            checked={revealing}
            disabled={!resolve}
            onCheckedChange={setReveal}
            aria-describedby={revealing ? ids.revealNote : undefined}
          />
          <Label htmlFor={ids.reveal} className="font-normal">
            Reveal secrets
          </Label>
        </div>
      </div>

      {revealing && (
        <p
          id={ids.revealNote}
          role="status"
          className="flex gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-status-client" />
          Secret values are in the code below. Don&apos;t paste it anywhere others can read it.
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {gen?.state === "error" && !loading ? (
          <p
            role="alert"
            className="flex h-72 items-start gap-2 rounded-md border p-3 text-xs text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {gen.message}
          </p>
        ) : (
          <CodeEditor
            value={code}
            readOnly
            language={editorLanguage(selected?.editor ?? "")}
            ariaLabel="Generated code"
            className="h-72 overflow-hidden rounded-md border bg-card font-mono text-xs"
          />
        )}
        {loading && (
          <p
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-2 rounded-md bg-background/70 text-xs text-muted-foreground"
          >
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> Generating…
          </p>
        )}
      </div>

      {gen?.state === "ok" && !loading && <Notes result={gen.result} languageId={langId} />}

      <DialogFooter>
        <Button disabled={loading || gen?.state !== "ok"} onClick={() => void copy()}>
          <Copy /> Copy
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function Notes({ result, languageId }: { result: CodeResult; languageId: string }) {
  const notes = [...codeNotes(result), ...result.warnings];
  return (
    <div role="note" aria-label="Notes" className="space-y-1 text-xs text-muted-foreground">
      {notes.length > 0 && (
        <div className="flex gap-2">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-status-client" />
          <ul className="space-y-0.5">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="flex gap-2">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        {addedHeadersNote(languageId)}
      </p>
    </div>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
