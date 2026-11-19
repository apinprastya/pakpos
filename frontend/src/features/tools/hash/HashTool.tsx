import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, EyeOff, FileUp, Hash, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { VarInput } from "@/components/editor/VarInput";
import { VarScopeContext } from "@/components/editor/varScopeContext";
import { useVariableScope } from "@/features/variables/useVariableScope";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { PreviewVariable } from "@/lib/model";
import type { HashAlgorithm, HashRequest, HashResult, KeyFormat } from "@/lib/toolModel";
import { cn } from "@/lib/utils";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore } from "@/stores/tabs";
import type { ToolProps } from "../registry";
import { resolveVars, type Resolution } from "../resolveVars";
import { MAX_TOOL_INPUT, useSettled } from "../useSettled";
import { ALGORITHMS, KEY_FORMATS, byteCount, fileName, hashRequest, isInsecure } from "./hash";
import type { HashToolState } from "./state";

/** Text is hashed this long after typing stops (each hash is a Go call). */
export const HASH_DEBOUNCE_MS = 150;

/** A finished hash, for the request it was made for (`sig`), or its error. */
interface Answer {
  sig: string;
  result: HashResult | null;
  error: string | null;
}

/** The hash and HMAC tool: text or a file on the left, its digest on the right. */
export function HashTool({ tabId, state, update }: ToolProps<HashToolState>) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId))!;
  const scope = useVariableScope(tab);
  const layout = usePanelLayout("tool.hash");
  const settled = useSettled(state.text);
  const set = (patch: Partial<HashToolState>) => update((s) => ({ ...s, ...patch }));

  const keyResolution: Resolution | null = useMemo(
    () => (state.hmac ? resolveVars(state.key, scope, state.revealed) : null),
    [state.hmac, state.key, scope, state.revealed],
  );
  const keyReady = !keyResolution || keyResolution.kind === "resolved";
  const resolvedKey = keyResolution?.kind === "resolved" ? keyResolution.value : "";
  const textMode = state.source === "text";
  const tooLarge = textMode && settled.length > MAX_TOOL_INPUT;

  // The request the inputs describe right now; null when it can't be made yet.
  const request: HashRequest | null = useMemo(() => {
    if (!keyReady || tooLarge) return null;
    if (textMode ? settled === "" : state.filePath === "") return null;
    return hashRequest({ ...state, text: settled }, resolvedKey);
  }, [keyReady, tooLarge, textMode, settled, state, resolvedKey]);
  const sig = request ? JSON.stringify(request) : "";

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef("");

  const run = async (req: HashRequest, s: string) => {
    latest.current = s;
    setBusy(true);
    let next: Answer;
    try {
      next = { sig: s, result: await api.hash(req), error: null };
    } catch (e) {
      next = { sig: s, result: null, error: errorMessage(e) };
    }
    // A newer request was started meanwhile: its answer wins.
    if (latest.current !== s) return;
    setAnswer(next);
    setBusy(false);
  };

  // Text is hashed as you type (after a short pause); files only on "Hash file".
  useEffect(() => {
    if (!textMode || !request) return;
    const timer = setTimeout(() => void run(request, sig), HASH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `sig` captures the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textMode, sig]);

  const shown = answer && answer.sig === sig ? answer : null;

  const chooseFile = async () => {
    try {
      const path = await api.pickHashFile();
      if (path) set({ filePath: path });
    } catch (e) {
      toast.error("Couldn't open the file picker", { description: errorMessage(e) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Hash aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Hash and HMAC</h1>
      </div>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${tabId}-alg`} className="text-xs font-normal text-muted-foreground">
            Algorithm
          </Label>
          <Select value={state.algorithm} onValueChange={(v) => set({ algorithm: v as HashAlgorithm })}>
            <SelectTrigger id={`${tabId}-alg`} size="sm" className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALGORITHMS.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.insecure ? `${a.label} (not secure, for checksums only)` : a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div role="radiogroup" aria-label="Source" className="flex gap-0.5">
          {(["text", "file"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={state.source === id}
              onClick={() => set({ source: id })}
              className={cn(
                "h-6 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                state.source === id && "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              {id === "text" ? "Text" : "File"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${tabId}-hmac`}
            checked={state.hmac}
            onCheckedChange={(v) => set({ hmac: v === true })}
          />
          <Label htmlFor={`${tabId}-hmac`} className="text-xs font-normal">
            HMAC
          </Label>
        </div>
      </div>
      {state.hmac && (
        <VarScopeContext.Provider value={scope}>
          <div className="flex shrink-0 flex-col gap-1 border-b px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Key</span>
              <VarInput
                value={state.key}
                onChange={(key) => set({ key })}
                ariaLabel="HMAC key"
                placeholder="Secret key, or {{variable}}"
                className="h-7 min-w-0 flex-1 rounded-md border px-2 text-xs"
              />
              <Select value={state.keyFormat} onValueChange={(v) => set({ keyFormat: v as KeyFormat })}>
                <SelectTrigger aria-label="Key format" size="sm" className="w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_FORMATS.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <KeyNote
              resolution={keyResolution!}
              onReveal={(v, value) => update((s) => ({ ...s, revealed: { ...s.revealed, [v.key]: value } }))}
              onHide={() => set({ revealed: {} })}
            />
          </div>
        </VarScopeContext.Provider>
      )}
      <ResizablePanelGroup orientation="horizontal" id="pakpos-tool-hash" {...layout}>
        <ResizablePanel id="input" defaultSize="50" minSize="25">
          <section aria-label="Input" className="flex h-full min-h-0 flex-col">
            {textMode ? (
              <>
                <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
                  <h2 className="text-xs font-medium text-muted-foreground">Text</h2>
                  <IconButton
                    label="Clear text"
                    disabled={state.text === ""}
                    onClick={() => set({ text: "" })}
                  >
                    <X />
                  </IconButton>
                </div>
                <CodeEditor
                  key={tabId}
                  value={state.text}
                  onChange={(text) => set({ text })}
                  gutters={false}
                  autoFocus={state.text === ""}
                  ariaLabel="Text to hash"
                  placeholder="Type or paste text. It's hashed as UTF-8."
                  className="min-h-0 flex-1 overflow-auto border-t"
                />
                {tooLarge && (
                  <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
                    Input is too large for this tool (over 10 MiB). Hash it as a file instead.
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-3 p-3">
                <h2 className="text-xs font-medium text-muted-foreground">File</h2>
                {state.filePath ? (
                  <p className="flex flex-col gap-0.5 text-sm">
                    <span className="font-medium">{fileName(state.filePath)}</span>
                    <span className="font-mono text-xs break-all text-muted-foreground">
                      {state.filePath}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Choose a file to hash. It's read in chunks, so large files are fine.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void chooseFile()}>
                    <FileUp /> Choose file…
                  </Button>
                  <Button
                    size="sm"
                    disabled={!request || busy}
                    onClick={() => request && void run(request, sig)}
                  >
                    {busy ? "Hashing…" : "Hash file"}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="output" minSize="25">
          <section aria-label="Digest" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
            <h2 className="text-xs font-medium text-muted-foreground">
              {state.hmac ? "HMAC" : "Digest"} ({ALGORITHMS.find((a) => a.id === state.algorithm)?.label})
            </h2>
            {isInsecure(state.algorithm) && (
              <p className="text-xs text-muted-foreground">
                This algorithm isn&apos;t secure: use it only to check that data hasn&apos;t changed by
                accident.
              </p>
            )}
            <Output
              answer={shown}
              waiting={textMode ? !!request && !shown : busy && !shown}
              emptyText={
                textMode
                  ? "The digest shows here as you type."
                  : state.filePath
                    ? "Select Hash file to read it."
                    : "Choose a file, then select Hash file."
              }
            />
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function Output({
  answer,
  waiting,
  emptyText,
}: {
  answer: Answer | null;
  waiting: boolean;
  emptyText: string;
}) {
  if (answer?.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {answer.error}
      </p>
    );
  }
  if (answer?.result) {
    const r = answer.result;
    return (
      <div className="flex flex-col gap-3">
        <DigestRow label="Hex" value={r.hex} />
        <DigestRow label="Base64" value={r.base64} />
        <p className="text-xs text-muted-foreground">From {byteCount(r.bytes)}.</p>
      </div>
    );
  }
  return (
    <p role={waiting ? "status" : undefined} className="text-sm text-muted-foreground">
      {waiting ? "Hashing…" : emptyText}
    </p>
  );
}

function DigestRow({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} digest copied`);
    } catch {
      toast.error(`Couldn't copy the ${label.toLowerCase()} digest`, {
        description: "The clipboard isn't available.",
      });
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <IconButton label={`Copy ${label.toLowerCase()} digest`} onClick={() => void copy()}>
          <Copy />
        </IconButton>
      </div>
      <p
        aria-label={`${label} digest`}
        className="rounded-md border bg-card px-2 py-1.5 font-mono text-xs break-all"
      >
        {value}
      </p>
    </div>
  );
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

/** Whether the key's variables resolve; Reveal for a secret, Hide once revealed. */
function KeyNote({
  resolution,
  onReveal,
  onHide,
}: {
  resolution: Resolution;
  onReveal: (v: PreviewVariable, value: string) => void;
  onHide: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const reveal = async (v: PreviewVariable) => {
    if (!(await useSecretsStore.getState().ensureReady())) return;
    setBusy(true);
    try {
      onReveal(v, await api.revealSecret({ kind: v.scope, id: v.scopeId }, v.key));
    } catch (e) {
      toast.error(`Couldn't reveal {{${v.key}}}`, { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const line = "flex items-center gap-2 text-xs";
  switch (resolution.kind) {
    case "pending":
      return (
        <p role="status" className={cn(line, "text-muted-foreground")}>
          Loading variables…
        </p>
      );
    case "error":
      return (
        <p role="alert" className={cn(line, "text-destructive")}>
          {resolution.message}
        </p>
      );
    case "secret":
      return (
        <div className={cn(line, "text-muted-foreground")}>
          <Lock aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-mono">{`{{${resolution.variable.key}}}`}</span> is a secret, not revealed.
            Reveal it to use it as the key.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void reveal(resolution.variable)}
          >
            <Eye /> Reveal
          </Button>
        </div>
      );
    default:
      if (resolution.secrets.length === 0) return null;
      return (
        <div className={cn(line, "text-muted-foreground")}>
          <span className="min-w-0 flex-1">
            Using the revealed value of{" "}
            <span className="font-mono">{resolution.secrets.map((n) => `{{${n}}}`).join(", ")}</span>.
          </span>
          <Button size="xs" variant="outline" onClick={onHide}>
            <EyeOff /> Hide
          </Button>
        </div>
      );
  }
}
