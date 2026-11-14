import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { api } from "@/lib/api";
import { methodTextClass } from "@/lib/http";
import type { CurlImport } from "@/lib/model";
import { findContainer } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { authSummary, bodySummary } from "./summary";

/** How long typing pauses before the command is parsed again. */
export const PARSE_DELAY_MS = 250;

type Parse = { state: "empty" } | { state: "ok"; result: CurlImport } | { state: "error"; message: string };

/** "Import cURL…": paste a command, check the preview, import it into a new tab. */
export function ImportCurlDialog() {
  const open = useCodeDialogsStore((s) => s.importOpen);
  const parentId = useCodeDialogsStore((s) => s.importParentId);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && useCodeDialogsStore.getState().closeImport()}>
      {open && <ImportBody parentId={parentId} />}
    </Dialog>
  );
}

function ImportBody({ parentId }: { parentId: string }) {
  const [text, setText] = useState("");
  const [parse, setParse] = useState<Parse>({ state: "empty" });
  const parent = useWorkspaceStore((s) => (parentId ? findContainer(s.collections, parentId) : undefined));

  useEffect(() => {
    if (!text.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      api.importCurl(text).then(
        (result) => current && setParse({ state: "ok", result }),
        (e: unknown) =>
          current && setParse({ state: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    }, PARSE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text]);

  const shown: Parse = text.trim() ? parse : { state: "empty" };
  const ready = shown.state === "ok";
  const doImport = () => {
    if (shown.state !== "ok") return;
    useTabsStore.getState().openDraft(shown.result.request, parent ? parentId : "");
    useCodeDialogsStore.getState().closeImport();
  };

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{parent ? `Import cURL into ${parent.name}` : "Import cURL"}</DialogTitle>
        <DialogDescription>
          Paste a curl command, for example from your browser&apos;s devtools (&quot;Copy as cURL&quot;). It
          opens as a new request.
        </DialogDescription>
      </DialogHeader>
      <CodeEditor
        value={text}
        onChange={setText}
        language="shell"
        ariaLabel="cURL command"
        placeholder="curl https://api.example.com/users -H 'Accept: application/json'"
        gutters={false}
        autoFocus
        className="h-44 overflow-hidden rounded-md border bg-card font-mono text-xs"
      />
      <Preview parse={shown} />
      <DialogFooter>
        <Button variant="outline" onClick={() => useCodeDialogsStore.getState().closeImport()}>
          Cancel
        </Button>
        <Button disabled={!ready} onClick={doImport}>
          Import
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function Preview({ parse }: { parse: Parse }) {
  if (parse.state === "empty") {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        The request will show here as you paste.
      </p>
    );
  }
  if (parse.state === "error") {
    return (
      <p role="alert" className="flex gap-2 text-xs text-destructive">
        <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        {parse.message}
      </p>
    );
  }
  const { request: r, warnings } = parse.result;
  const headers = r.headers.filter((h) => h.enabled);
  return (
    <section aria-label="Preview" aria-live="polite" className="min-w-0 space-y-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-2 py-1.5 font-mono">
        <span className={cn("shrink-0 font-bold", methodTextClass(r.method))}>{r.method}</span>
        <span className="truncate" title={r.url}>
          {r.url}
        </span>
      </div>
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Name</dt>
        <dd className="truncate">{r.name || "Untitled request"}</dd>
        <dt className="text-muted-foreground">Headers</dt>
        <dd className="truncate" title={headers.map((h) => h.key).join(", ")}>
          {headers.length ? `${headers.length}: ${headers.map((h) => h.key).join(", ")}` : "None"}
        </dd>
        <dt className="text-muted-foreground">Body</dt>
        <dd className="truncate">{bodySummary(r.body)}</dd>
        <dt className="text-muted-foreground">Auth</dt>
        <dd className="truncate">{authSummary(r.auth)}</dd>
      </dl>
      {warnings.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-md border px-3 py-2 text-muted-foreground">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-client" />
            {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}
          </p>
          <ul aria-label="Warnings" className="mt-1 list-disc space-y-0.5 pl-5">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.option && <span className="font-mono text-foreground">{w.option}</span>}
                {w.option && ": "}
                {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
