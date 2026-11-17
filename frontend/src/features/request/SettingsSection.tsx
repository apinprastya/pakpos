import { useId, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Request, RequestSettings } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";
import {
  appValueLabel,
  formatSeconds,
  overrideCount,
  parseMaxRedirects,
  parseTimeout,
  REDIRECTS_ERROR,
  TIMEOUT_ERROR,
  withSetting,
} from "./requestSettings";

interface Props {
  request: Request;
  onChange: (update: (req: Request) => Request) => void;
}

const APP = "app";

/** Per-request overrides of the app's timeout, redirect and TLS settings. */
export function SettingsSection({ request, onChange }: Props) {
  const app = useSettingsStore((s) => s.settings);
  const settings = request.settings;
  const set = <K extends keyof RequestSettings>(key: K, value: RequestSettings[K] | undefined) =>
    onChange((r) => ({ ...r, settings: withSetting(r.settings, key, value) }));
  const follows = settings.followRedirects ?? app.followRedirects;
  const verifies = settings.verifyTls ?? app.verifyTls;

  return (
    <section aria-label="Request settings" className="flex max-w-xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          These apply to this request only. Anything left on "Use app setting" follows Settings &gt; Requests.
        </p>
        {overrideCount(settings) > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => onChange((r) => ({ ...r, settings: {} }))}
          >
            Use app settings for all
          </Button>
        )}
      </div>

      <NumberSetting
        label="Timeout"
        suffix="seconds"
        hint="How long to wait for the whole request. 0 waits with no limit."
        appLabel={appValueLabel("timeoutMs", app)}
        value={settings.timeoutMs}
        defaultValue={app.timeoutMs}
        format={formatSeconds}
        parse={parseTimeout}
        error={TIMEOUT_ERROR}
        onChange={(v) => set("timeoutMs", v)}
      />
      <BoolSetting
        label="Follow redirects"
        appLabel={appValueLabel("followRedirects", app)}
        value={settings.followRedirects}
        onChange={(v) => set("followRedirects", v)}
      />
      <NumberSetting
        label="Maximum redirects"
        hint={
          follows
            ? "Stop after this many redirects in a row."
            : "Not used: this request doesn't follow redirects."
        }
        appLabel={appValueLabel("maxRedirects", app)}
        value={settings.maxRedirects}
        defaultValue={app.maxRedirects}
        format={String}
        parse={parseMaxRedirects}
        error={REDIRECTS_ERROR}
        onChange={(v) => set("maxRedirects", v)}
      />
      <BoolSetting
        label="Verify TLS certificates"
        appLabel={appValueLabel("verifyTls", app)}
        value={settings.verifyTls}
        onChange={(v) => set("verifyTls", v)}
      />
      {!verifies && (
        <div
          role="note"
          className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <p>This request accepts any certificate, including self-signed and expired ones.</p>
        </div>
      )}
    </section>
  );
}

function Row({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-3">
      <Label htmlFor={id} className="pt-2">
        {label}
      </Label>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function BoolSetting({
  label,
  appLabel,
  value,
  onChange,
}: {
  label: string;
  appLabel: string;
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
}) {
  const id = useId();
  const current = value === undefined ? APP : value ? "on" : "off";
  return (
    <Row id={id} label={label}>
      <Select value={current} onValueChange={(v) => onChange(v === APP ? undefined : v === "on")}>
        <SelectTrigger id={id} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={APP}>Use app setting ({appLabel})</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </Row>
  );
}

function NumberSetting({
  label,
  hint,
  suffix,
  appLabel,
  value,
  defaultValue,
  format,
  parse,
  error,
  onChange,
}: {
  label: string;
  hint: string;
  suffix?: string;
  appLabel: string;
  value: number | undefined;
  /** Where a new override starts: the app setting. */
  defaultValue: number;
  format: (n: number) => string;
  parse: (text: string) => number | null;
  error: string;
  onChange: (v: number | undefined) => void;
}) {
  const id = useId();
  const custom = value !== undefined;
  const [text, setText] = useState(() => (custom ? format(value) : ""));
  const [invalid, setInvalid] = useState(false);

  // Follow changes made elsewhere (cURL import, undo, "Use app settings for
  // all"), unless the text already means that value.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== undefined && parse(text) !== value) setText(format(value));
    setInvalid(false);
  }

  const onText = (t: string) => {
    setText(t);
    const n = parse(t);
    setInvalid(n === null);
    if (n !== null && n !== value) onChange(n);
  };

  return (
    <Row id={id} label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={custom ? "custom" : APP}
          onValueChange={(v) => {
            if (v === APP) {
              setInvalid(false);
              onChange(undefined);
            } else {
              setText(format(defaultValue));
              onChange(defaultValue);
            }
          }}
        >
          <SelectTrigger id={id} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={APP}>Use app setting ({appLabel})</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
        {custom && (
          <>
            <Input
              aria-label={`${label} for this request`}
              inputMode="decimal"
              value={text}
              onChange={(e) => onText(e.target.value)}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={`${id}-hint`}
              className="h-8 w-24 tabular-nums"
            />
            {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
          </>
        )}
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid ? error : hint}
      </p>
    </Row>
  );
}
