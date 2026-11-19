import { useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ChevronRight, Code2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeEditor } from "@/components/editor/CodeEditor";
import type { ScriptEvent, ScriptLevelKind, Scripts } from "@/lib/model";
import { cn } from "@/lib/utils";
import { openContainerScripts } from "./open";
import { pmCompletions } from "./pmApi";
import { ONLY_REASON, SNIPPETS, snippetInsert } from "./snippets";
import type { InheritedScript } from "./useInheritedScripts";

const EVENTS = ["prerequest", "test"] as const;
const FIELD: Record<ScriptEvent, keyof Scripts> = { prerequest: "preRequest", test: "test" };
const EDITOR_LABEL: Record<ScriptEvent, string> = { prerequest: "Pre-request script", test: "Test script" };

/** Where each script's completions come from (built once: sources are pure). */
const COMPLETIONS: Record<ScriptEvent, ReturnType<typeof pmCompletions>[]> = {
  prerequest: [pmCompletions("prerequest")],
  test: [pmCompletions("test")],
};

export interface ScriptsSectionProps {
  /** Tab id: each tab and script gets its own editor (and undo history). */
  tabKey: string;
  owner: ScriptLevelKind;
  scripts: Scripts;
  onChange: (update: (s: Scripts) => Scripts) => void;
  /** The collection and folders above, whose scripts run first (collection first). */
  inherited: InheritedScript[];
  event: ScriptEvent;
  onEventChange: (event: string) => void;
}

/** The Scripts section of a request, folder or collection: pre-request and test scripts. */
export function ScriptsSection({
  tabKey,
  owner,
  scripts,
  onChange,
  inherited,
  event,
  onEventChange,
}: ScriptsSectionProps) {
  const view = useRef<EditorView | null>(null);
  const field = FIELD[event];
  const value = scripts[field];

  const insert = (code: string) => {
    const v = view.current;
    if (!v) return;
    const pos = v.state.selection.main.head;
    const text = snippetInsert(v.state.doc.toString(), pos, code);
    v.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: "input",
    });
    v.focus();
  };

  return (
    <Tabs value={event} onValueChange={onEventChange} className="flex h-full min-h-0 flex-col gap-0">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <TabsList className="h-7" aria-label="Script">
          <TabsTrigger value="prerequest" className="px-2 text-xs">
            Pre-request <ScriptDot on={scripts.preRequest.trim() !== ""} />
          </TabsTrigger>
          <TabsTrigger value="test" className="px-2 text-xs">
            Tests <ScriptDot on={scripts.test.trim() !== ""} />
          </TabsTrigger>
        </TabsList>
        <SnippetsMenu event={event} onInsert={insert} />
      </div>
      <InheritedScripts key={`${tabKey}:${event}`} owner={owner} event={event} inherited={inherited} />
      {value.trim() === "" && <HelpText owner={owner} event={event} />}
      {EVENTS.map((ev) => (
        <TabsContent key={ev} value={ev} className="min-h-0 flex-1">
          <CodeEditor
            key={`${tabKey}:${ev}`}
            className="h-full"
            language="javascript"
            ariaLabel={EDITOR_LABEL[ev]}
            value={scripts[FIELD[ev]]}
            onChange={(text) => onChange((s) => ({ ...s, [FIELD[ev]]: text }))}
            completions={COMPLETIONS[ev]}
            onView={(v) => {
              // Only the open script's editor is mounted.
              view.current = v;
            }}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ScriptDot({ on }: { on: boolean }) {
  if (!on) return null;
  return <span aria-label="has a script" className="size-1.5 rounded-full bg-primary" />;
}

function SnippetsMenu({ event, onInsert }: { event: ScriptEvent; onInsert: (code: string) => void }) {
  const inserted = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground">
          <Code2 /> Snippets
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80"
        onCloseAutoFocus={(e) => {
          // The editor has focus after an insert; don't move it back to the button.
          if (inserted.current) e.preventDefault();
          inserted.current = false;
        }}
      >
        {SNIPPETS.map((s) => {
          const disabled = !!s.only && s.only !== event;
          return (
            <DropdownMenuItem
              key={s.id}
              disabled={disabled}
              className="flex-col items-start gap-0"
              onSelect={() => {
                inserted.current = true;
                onInsert(s.code);
              }}
            >
              <span>{s.label}</span>
              {disabled && <span className="text-xs text-muted-foreground">{ONLY_REASON[s.only!]}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const OWNER_NOUN: Record<ScriptLevelKind, string> = {
  request: "this request",
  folder: "every request in this folder",
  collection: "every request in this collection",
};

function HelpText({ owner, event }: { owner: ScriptLevelKind; event: ScriptEvent }) {
  const first =
    owner === "collection"
      ? "It runs before the scripts of the folders and requests in it."
      : owner === "folder"
        ? "The collection's and outer folders' scripts run first; the requests' own scripts run after it."
        : "The collection's and folders' scripts run first.";
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-3 py-2 text-xs text-muted-foreground">
      {event === "prerequest" ? (
        <p>
          Runs before {OWNER_NOUN[owner]} is sent. Use it to set variables, headers or the body, for example{" "}
          <code className="font-mono">pm.environment.set(&quot;ts&quot;, Date.now())</code>. {first}
        </p>
      ) : (
        <p>
          Runs after the response of {OWNER_NOUN[owner]} arrives. Check it with{" "}
          <code className="font-mono">pm.test</code> and <code className="font-mono">pm.expect</code>, or save
          values from it, such as a token for the next request. Results show in the response&apos;s Tests tab.{" "}
          {first}
        </p>
      )}
      <p>Type pm. for suggestions, or insert one from Snippets.</p>
    </div>
  );
}

/** The scripts of the levels above that run first: a collapsed line that expands to read-only copies. */
function InheritedScripts({
  owner,
  event,
  inherited,
}: {
  owner: ScriptLevelKind;
  event: ScriptEvent;
  inherited: InheritedScript[];
}) {
  const [open, setOpen] = useState(false);
  const field = FIELD[event];
  const levels = useMemo(() => inherited.filter((l) => l.scripts[field].trim() !== ""), [inherited, field]);
  if (levels.length === 0) return null;
  const noun = owner === "folder" ? "this folder's" : "this request's";
  const names = levels
    .map((l) => `${l.kind === "collection" ? "Collection" : "Folder"} ${l.name}`)
    .join(", ");
  return (
    <div className="shrink-0 border-b text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0", open && "rotate-90")} />
        <span className="truncate">
          Runs before {noun} script: {names}
        </span>
      </button>
      {open && (
        <div className="flex max-h-64 flex-col gap-2 overflow-auto px-3 pb-2">
          {levels.map((l) => {
            const label = `${l.kind === "collection" ? "Collection" : "Folder"} ${l.name}`;
            return (
              <div key={l.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{label}</span>
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto p-0"
                    onClick={() => openContainerScripts(l, event)}
                  >
                    <ExternalLink /> Open {l.kind} settings
                  </Button>
                </div>
                <CodeEditor
                  className="rounded-sm border"
                  language="javascript"
                  readOnly
                  ariaLabel={`${label} ${EDITOR_LABEL[event].toLowerCase()}`}
                  value={l.scripts[field]}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
