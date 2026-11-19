import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { EmptyState } from "@/features/sidebar/EmptyState";
import { relativeTime } from "@/features/request/oauth2";
import { useVariableScope } from "@/features/variables/useVariableScope";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { PreviewVariable } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore } from "@/stores/tabs";
import type { ToolProps } from "../registry";
import { resolveVars, type Resolution } from "../resolveVars";
import {
  claimTimeText,
  decodeJwt,
  timeStatus,
  tokenTimeStatus,
  type ClaimInfo,
  type DecodedJwt,
} from "./jwt";
import type { JwtState } from "./state";

/** Text tools stop at 10 MiB instead of freezing the UI. */
export const MAX_INPUT = 10 * 1024 * 1024;

/** How often relative times ("expires in 4 min") refresh. */
const TICK_MS = 15_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The JWT decoder: a token (or a `{{variable}}` holding one) on the left, what it says on the right. */
export function JwtTool({ tabId, state, update }: ToolProps<JwtState>) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId))!;
  const scope = useVariableScope(tab);
  const layout = usePanelLayout("tool.jwt");
  const now = useNow();

  const resolution = useMemo(
    () => resolveVars(state.token, scope, state.revealed),
    [state.token, scope, state.revealed],
  );
  const tooLarge = resolution.kind === "resolved" && resolution.value.length > MAX_INPUT;
  const decoded = useMemo(
    () => (resolution.kind === "resolved" && !tooLarge ? decodeJwt(resolution.value) : null),
    [resolution, tooLarge],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <KeyRound aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">JWT decoder</h1>
        <p className="ml-auto truncate text-xs text-muted-foreground">
          Decoded on this device. The token isn&apos;t sent anywhere.
        </p>
      </div>
      <ResizablePanelGroup orientation="horizontal" id="pakpos-tool-jwt" {...layout}>
        <ResizablePanel id="input" defaultSize="45" minSize="25">
          <section aria-label="Token" className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
              <h2 className="text-xs font-medium text-muted-foreground">Token</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear token"
                    disabled={state.token === ""}
                    onClick={() => update(() => ({ token: "", revealed: {} }))}
                  >
                    <X />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Clear token</TooltipContent>
              </Tooltip>
            </div>
            <CodeEditor
              key={tabId}
              value={state.token}
              onChange={(token) => update((s) => ({ ...s, token }))}
              language="jwt"
              gutters={false}
              variables={scope}
              autoFocus={state.token === ""}
              ariaLabel="JWT"
              placeholder="Paste a JWT, or type {{variable}} to use one from the environment"
              className="min-h-0 flex-1 overflow-auto border-y"
            />
            <ResolutionNote
              resolution={resolution}
              environment={scope.environment?.name ?? ""}
              tooLarge={tooLarge}
              onReveal={(v, value) => update((s) => ({ ...s, revealed: { ...s.revealed, [v.key]: value } }))}
              onHide={() => update((s) => ({ ...s, revealed: {} }))}
            />
          </section>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="output" minSize="30">
          <section aria-label="Decoded token" className="h-full min-h-0 overflow-y-auto">
            {decoded ? (
              <Decoded decoded={decoded} now={now} />
            ) : (
              <EmptyState
                icon={<KeyRound className="size-6" />}
                title="Nothing to decode yet"
                body="Paste a token on the left. Its header, payload and expiry show here as you type."
              />
            )}
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function ResolutionNote({
  resolution,
  environment,
  tooLarge,
  onReveal,
  onHide,
}: {
  resolution: Resolution;
  environment: string;
  tooLarge: boolean;
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

  const line = "flex min-h-9 shrink-0 items-center gap-2 px-3 py-1.5 text-xs";
  if (tooLarge) {
    return (
      <p role="alert" className={cn(line, "text-destructive")}>
        Input is too large for this tool (over 10 MiB).
      </p>
    );
  }
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
      if (resolution.secrets.length > 0) {
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
      if (resolution.hasVars) {
        return (
          <p className={cn(line, "text-muted-foreground")}>
            {environment
              ? `Variables resolved with the ${environment} environment.`
              : "Variables resolved with no environment selected."}
          </p>
        );
      }
      return null;
  }
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`, { description: "The clipboard isn't available." });
  }
}

function CopyButton({ text, what }: { text: string; what: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${what.toLowerCase()}`}
          disabled={!text}
          onClick={() => void copy(text, what)}
        >
          <Copy />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Copy {what.toLowerCase()}</TooltipContent>
    </Tooltip>
  );
}

function Part({ title, copyText, children }: { title: string; copyText: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-b">
      <div className="flex h-9 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        <CopyButton text={copyText} what={title} />
      </div>
      {children}
    </section>
  );
}

function Decoded({ decoded, now }: { decoded: DecodedJwt; now: number }) {
  if (decoded.kind === "empty") {
    return (
      <EmptyState
        icon={<KeyRound className="size-6" />}
        title="Nothing to decode yet"
        body="The variable is empty. Give it a token, or paste one on the left."
      />
    );
  }
  return (
    <div className="flex flex-col">
      <Summary decoded={decoded} now={now} />
      {decoded.headerText && (
        <Part title="Header" copyText={decoded.headerText}>
          <CodeEditor
            value={decoded.headerText}
            language="json"
            readOnly
            gutters={false}
            ariaLabel="Header JSON"
          />
        </Part>
      )}
      {decoded.kind !== "jwe" && decoded.payloadText && (
        <Part title="Payload" copyText={decoded.payloadText}>
          <CodeEditor
            value={decoded.payloadText}
            language={decoded.payload === undefined ? "text" : "json"}
            readOnly
            gutters={false}
            ariaLabel="Payload JSON"
          />
        </Part>
      )}
      {decoded.claims.length > 0 && <Claims claims={decoded.claims} now={now} />}
      {decoded.kind !== "jwe" && decoded.signature && (
        <Part title="Signature" copyText={decoded.signature}>
          <p className="px-3 pb-3 font-mono text-xs break-all text-muted-foreground">{decoded.signature}</p>
        </Part>
      )}
    </div>
  );
}

function Summary({ decoded, now }: { decoded: DecodedJwt; now: number }) {
  const time = tokenTimeStatus(decoded.claims, now);
  const exp = decoded.claims.find((c) => c.name === "exp" && c.seconds !== undefined);
  const nbf = decoded.claims.find((c) => c.name === "nbf" && c.seconds !== undefined);
  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2.5 text-sm">
      {decoded.kind === "jwe" ? (
        <p className="font-medium">Encrypted token (JWE), can&apos;t be decoded without the key.</p>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {decoded.alg && (
            <span>
              Algorithm <span className="font-mono">{decoded.alg}</span>
            </span>
          )}
          {decoded.unsigned && <span className="font-medium text-status-client">Unsigned token</span>}
          {time === "expired" && exp && (
            <span className="font-medium text-status-client">
              Expired {relativeTime(exp.seconds! * 1000, now)}
            </span>
          )}
          {time === "notYet" && nbf && (
            <span className="font-medium text-status-client">
              Not valid yet (starts {relativeTime(nbf.seconds! * 1000, now)})
            </span>
          )}
          {time === "valid" && (
            <span className="font-medium text-status-ok">
              {exp ? `Valid, expires ${relativeTime(exp.seconds! * 1000, now)}` : "Valid, no expiry"}
            </span>
          )}
          {decoded.kind === "jws" && !decoded.unsigned && (
            <span className="text-xs text-muted-foreground">Signature not checked</span>
          )}
        </p>
      )}
      {decoded.errors.length > 0 && (
        <ul role="alert" aria-label="Problems" className="flex flex-col gap-0.5 text-xs text-destructive">
          {decoded.errors.map((e) => (
            <li key={e.segment + e.message}>{e.message}</li>
          ))}
        </ul>
      )}
      {decoded.warnings.length > 0 && (
        <ul aria-label="Warnings" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {decoded.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  valid: "text-status-ok",
  expired: "text-status-client",
  notYet: "text-status-client",
  neutral: "text-muted-foreground",
};

function Claims({ claims, now }: { claims: ClaimInfo[]; now: number }) {
  return (
    <section aria-label="Claims" className="border-b">
      <div className="flex h-9 items-center pl-3">
        <h2 className="text-xs font-medium text-muted-foreground">Claims</h2>
      </div>
      <table className="mb-2 w-full text-sm">
        <tbody>
          {claims.map((c) => (
            <tr key={c.name} className="align-top">
              <th scope="row" className="w-32 py-1 pr-2 pl-3 text-left font-normal text-muted-foreground">
                {c.label} <span className="font-mono text-xs">({c.name})</span>
              </th>
              <td className="py-1 pr-3">
                {c.seconds === undefined ? (
                  <span className="font-mono text-xs break-all">{c.text}</span>
                ) : (
                  <span className="flex flex-col">
                    <span>
                      {new Date(c.seconds * 1000).toLocaleString()}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{c.text}</span>
                    </span>
                    <span className={cn("text-xs", STATUS_CLASS[timeStatus(c, now)])}>
                      {claimTimeText(c, now)}
                    </span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
