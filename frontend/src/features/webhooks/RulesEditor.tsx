import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { KeyValueTable } from "@/features/request/KeyValueTable";
import { HTTP_METHODS, methodTextClass } from "@/lib/http";
import {
  ANY_METHOD,
  CONDITION_OPS,
  CONDITION_SOURCES,
  MAX_DELAY_MS,
  languageFor,
  newCondition,
  newRule,
  type Condition,
  type ConditionOp,
  type ConditionSource,
  type Webhook,
  type WebhookProblem,
  type WebhookResponse,
  type WebhookRule,
} from "@/lib/webhookModel";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { useWebhooksStore } from "@/stores/webhooks";
import { templateCompletions } from "./completions";
import { NumberField } from "./NumberField";
import { moveRule, ruleSummary } from "./format";

/** "" in the selection means the default response. */
const DEFAULT_ID = "";

const SOURCE_LABELS: Record<ConditionSource, string> = {
  header: "Header",
  query: "Query parameter",
  body: "Body",
  json: "JSON value",
};

const OP_LABELS: Record<ConditionOp, string> = {
  equals: "equals",
  contains: "contains",
  exists: "exists",
  matches: "matches regex",
};

const NAME_PLACEHOLDER: Record<ConditionSource, string> = {
  header: "Header name",
  query: "Parameter name",
  body: "",
  json: "Path, e.g. data.object.status",
};

/** The ordered rules of a webhook (first match wins) and the editor of the selected one. */
export function RulesEditor({ tabId, webhook }: { tabId: string; webhook: Webhook }) {
  const selected = useWebhooksStore((s) => s.selectedRule[tabId]);
  const problem = useWebhooksStore((s) => s.problems[tabId] ?? null);
  const store = useWebhooksStore.getState;
  const update = (fn: (w: Webhook) => Webhook) => useTabsStore.getState().updateWebhook(tabId, fn);
  const selectedId =
    selected === DEFAULT_ID || webhook.rules.some((r) => r.id === selected)
      ? selected
      : (webhook.rules[0]?.id ?? DEFAULT_ID);
  const rule = webhook.rules.find((r) => r.id === selectedId);
  const index = rule ? webhook.rules.indexOf(rule) : -1;

  const updateRule = (fn: (r: WebhookRule) => WebhookRule) =>
    update((w) => ({ ...w, rules: w.rules.map((r) => (r.id === selectedId ? fn(r) : r)) }));
  const addRule = () => {
    const r = newRule();
    update((w) => ({ ...w, rules: [...w.rules, r] }));
    store().selectRule(tabId, r.id);
  };
  const move = (i: number, delta: -1 | 1) =>
    update((w) => ({ ...w, rules: moveRule(w.rules, i, i + delta) }));
  const removeRule = (id: string) => {
    update((w) => ({ ...w, rules: w.rules.filter((r) => r.id !== id) }));
    store().selectRule(tabId, DEFAULT_ID);
  };
  const problemFor = (id: string): WebhookProblem | null =>
    problem && problem.ruleId === id ? problem : null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Rules" className="flex w-80 shrink-0 flex-col border-r">
        <div className="flex h-10 shrink-0 items-center justify-between border-b pr-2 pl-3">
          <p className="text-xs text-muted-foreground">Checked top to bottom; the first match replies.</p>
          <Button variant="ghost" size="sm" onClick={addRule}>
            <Plus /> Add rule
          </Button>
        </div>
        <ol aria-label="Rule order" className="min-h-0 flex-1 overflow-y-auto">
          {webhook.rules.map((r, i) => (
            <li
              key={r.id}
              className={cn(
                "group/rule flex items-center gap-2 border-b px-2 py-1.5",
                r.id === selectedId && "bg-accent",
                problemFor(r.id) && "border-l-2 border-l-destructive",
              )}
            >
              <Checkbox
                checked={r.enabled}
                aria-label={`Enable ${r.name || `rule ${i + 1}`}`}
                onCheckedChange={(v) =>
                  update((w) => ({
                    ...w,
                    rules: w.rules.map((x) => (x.id === r.id ? { ...x, enabled: v === true } : x)),
                  }))
                }
              />
              <button
                type="button"
                aria-current={r.id === selectedId ? "true" : undefined}
                onClick={() => store().selectRule(tabId, r.id)}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    move(i, e.key === "ArrowUp" ? -1 : 1);
                  }
                }}
                className={cn(
                  "flex min-w-0 flex-1 flex-col text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  !r.enabled && "opacity-60",
                )}
              >
                <span className="truncate text-[13px]">{r.name || `Rule ${i + 1}`}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{ruleSummary(r)}</span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${r.name || `rule ${i + 1}`} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${r.name || `rule ${i + 1}`} down`}
                disabled={i === webhook.rules.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
            </li>
          ))}
          {webhook.rules.length === 0 && (
            <li className="p-4 text-xs text-muted-foreground">
              No rules yet: every request gets the default response. Add a rule to reply differently to some
              requests, or use “Create rule” on a received request.
            </li>
          )}
        </ol>
        <button
          type="button"
          aria-current={selectedId === DEFAULT_ID ? "true" : undefined}
          onClick={() => store().selectRule(tabId, DEFAULT_ID)}
          className={cn(
            "flex shrink-0 flex-col border-t px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
            selectedId === DEFAULT_ID && "bg-accent",
            problemFor(DEFAULT_ID) && "border-l-2 border-l-destructive",
          )}
        >
          <span className="text-[13px]">Default response</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            When no rule matches · {webhook.defaultResponse.status}
          </span>
        </button>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {rule ? (
          <RuleForm
            key={rule.id}
            rule={rule}
            position={index + 1}
            problem={problemFor(rule.id)}
            onChange={updateRule}
            onDelete={() => removeRule(rule.id)}
          />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <div>
              <h2 className="text-sm font-semibold">Default response</h2>
              <p className="text-xs text-muted-foreground">Sent when no enabled rule matches the request.</p>
            </div>
            <ProblemNote problem={problemFor(DEFAULT_ID)} />
            <ResponseForm
              idPrefix={`${tabId}-default`}
              response={webhook.defaultResponse}
              problem={problemFor(DEFAULT_ID)}
              onChange={(fn) => update((w) => ({ ...w, defaultResponse: fn(w.defaultResponse) }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProblemNote({ problem }: { problem: WebhookProblem | null }) {
  if (!problem) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
      {problem.message}
    </p>
  );
}

function invalid(problem: WebhookProblem | null, field: string): boolean {
  return !!problem && (problem.field === field || problem.field.startsWith(`${field}.`));
}

function RuleForm({
  rule,
  position,
  problem,
  onChange,
  onDelete,
}: {
  rule: WebhookRule;
  position: number;
  problem: WebhookProblem | null;
  onChange: (fn: (r: WebhookRule) => WebhookRule) => void;
  onDelete: () => void;
}) {
  const id = `rule-${rule.id}`;
  const setMatch = (patch: Partial<WebhookRule["match"]>) =>
    onChange((r) => ({ ...r, match: { ...r.match, ...patch } }));
  const setCondition = (i: number, patch: Partial<Condition>) =>
    setMatch({ conditions: rule.match.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const method = rule.match.method;
  const methods = [
    ANY_METHOD,
    ...HTTP_METHODS,
    ...(method !== ANY_METHOD && !HTTP_METHODS.includes(method as never) ? [method] : []),
  ];

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Rule name</Label>
          <Input
            id={`${id}-name`}
            value={rule.name}
            placeholder={`Rule ${position}`}
            onChange={(e) => onChange((r) => ({ ...r, name: e.target.value }))}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            checked={rule.enabled}
            onCheckedChange={(v) => onChange((r) => ({ ...r, enabled: v === true }))}
          />
          Enabled
        </label>
      </div>
      <ProblemNote problem={problem} />

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">When the request matches</legend>
        <div className="flex gap-2">
          <Select value={method} onValueChange={(v) => setMatch({ method: v })}>
            <SelectTrigger
              aria-label="Method"
              className={cn("w-32 font-mono", method !== ANY_METHOD && methodTextClass(method))}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {methods.map((m) => (
                <SelectItem key={m} value={m} className="font-mono">
                  {m === ANY_METHOD ? "Any method" : m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Path"
            aria-invalid={invalid(problem, "path") || undefined}
            value={rule.match.path}
            placeholder="/payments/*"
            onChange={(e) => setMatch({ path: e.target.value })}
            className="flex-1 font-mono"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">*</code> matches one part of the path,{" "}
          <code className="font-mono">**</code> the rest of it, and <code className="font-mono">:name</code>{" "}
          one part you can use in the reply as <code className="font-mono">{"{{$request.params.name}}"}</code>
          .
        </p>
        {rule.match.conditions.length > 0 && (
          <ul aria-label="Conditions" className="flex flex-col gap-2">
            {rule.match.conditions.map((c, i) => (
              <ConditionRow
                key={i}
                index={i}
                condition={c}
                invalidField={
                  problem?.field.startsWith(`conditions.${i}.`) ? problem.field.split(".")[2] : undefined
                }
                onChange={(patch) => setCondition(i, patch)}
                onRemove={() => setMatch({ conditions: rule.match.conditions.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMatch({ conditions: [...rule.match.conditions, newCondition()] })}
          >
            <Plus /> Add condition
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">Reply with</legend>
        <ResponseForm
          idPrefix={id}
          response={rule.response}
          problem={problem}
          onChange={(fn) => onChange((r) => ({ ...r, response: fn(r.response) }))}
        />
      </fieldset>

      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          Deleting a rule takes effect when you save the webhook.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 /> Delete rule
        </Button>
      </div>
    </div>
  );
}

function ConditionRow({
  index,
  condition,
  invalidField,
  onChange,
  onRemove,
}: {
  index: number;
  condition: Condition;
  invalidField?: string;
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <li className="flex items-center gap-2">
      <Select value={condition.source} onValueChange={(v) => onChange({ source: v as ConditionSource })}>
        <SelectTrigger aria-label={`Condition ${n} source`} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONDITION_SOURCES.map((s) => (
            <SelectItem key={s} value={s}>
              {SOURCE_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {condition.source !== "body" && (
        <Input
          aria-label={`Condition ${n} name`}
          aria-invalid={invalidField === "name" || undefined}
          value={condition.name}
          placeholder={NAME_PLACEHOLDER[condition.source]}
          onChange={(e) => onChange({ name: e.target.value })}
          className="w-48 font-mono"
        />
      )}
      <Select value={condition.op} onValueChange={(v) => onChange({ op: v as ConditionOp })}>
        <SelectTrigger aria-label={`Condition ${n} test`} className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONDITION_OPS.map((o) => (
            <SelectItem key={o} value={o}>
              {OP_LABELS[o]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {condition.op !== "exists" && (
        <Input
          aria-label={`Condition ${n} value`}
          aria-invalid={invalidField === "value" || undefined}
          value={condition.value}
          placeholder={condition.op === "matches" ? "Regular expression" : "Value"}
          onChange={(e) => onChange({ value: e.target.value })}
          className="min-w-0 flex-1 font-mono"
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove condition ${n}`}
        onClick={onRemove}
        className="ml-auto"
      >
        <X />
      </Button>
    </li>
  );
}

function ResponseForm({
  idPrefix,
  response,
  problem,
  onChange,
}: {
  idPrefix: string;
  response: WebhookResponse;
  problem: WebhookProblem | null;
  onChange: (fn: (r: WebhookResponse) => WebhookResponse) => void;
}) {
  const contentType =
    response.headers.find((h) => h.enabled && h.key.toLowerCase() === "content-type")?.value ?? "";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-status`}>Status</Label>
          <NumberField
            id={`${idPrefix}-status`}
            hint="100–599"
            invalid={invalid(problem, "status")}
            value={response.status}
            onChange={(status) => onChange((r) => ({ ...r, status }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-delay`}>Delay (ms)</Label>
          <NumberField
            id={`${idPrefix}-delay`}
            hint={`0–${MAX_DELAY_MS}`}
            invalid={invalid(problem, "delayMs")}
            value={response.delayMs}
            onChange={(delayMs) => onChange((r) => ({ ...r, delayMs }))}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Headers</span>
        <div className={cn("rounded-md border", invalid(problem, "headers") && "border-destructive")}>
          <KeyValueTable
            rows={response.headers}
            onChange={(headers) => onChange((r) => ({ ...r, headers }))}
            label="Reply headers"
            keyPlaceholder="Header"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Body</span>
        <p className="text-xs text-muted-foreground">
          Type <code className="font-mono">{"{{"}</code> to use the request, such as{" "}
          <code className="font-mono">{"{{$request.json.data.id}}"}</code>. Workspace variables aren&apos;t
          available here: the URL can be public.
        </p>
        <div
          className={cn(
            "h-64 overflow-hidden rounded-md border",
            invalid(problem, "body") && "border-destructive",
          )}
        >
          <CodeEditor
            value={response.body}
            onChange={(body) => onChange((r) => ({ ...r, body }))}
            language={languageFor(contentType, response.body)}
            gutters
            completions={[templateCompletions]}
            ariaLabel="Reply body"
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}
