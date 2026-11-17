import { useEffect, useId, useState } from "react";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { NetworkSecretStatus, ProxyMode } from "@/lib/model";
import { cn } from "@/lib/utils";
import { emptyCert, type CertDraft, type DraftErrors, type SettingsDraft } from "./settingsForm";

interface Props {
  draft: SettingsDraft;
  update: (patch: Partial<SettingsDraft>) => void;
  errors: DraftErrors;
}

/** Proxy, extra CA certificates and client certificates. Passwords go to the secret store on save. */
export function NetworkSection({ draft, update, errors }: Props) {
  const [status, setStatus] = useState<NetworkSecretStatus | null>(null);
  useEffect(() => {
    let live = true;
    api.networkSecretStatus().then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const setCert = (id: string, patch: Partial<CertDraft>) =>
    update({ certs: draft.certs.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <section aria-label="Network" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Proxy</h3>
        <RadioGroup
          aria-label="Proxy"
          value={draft.proxyMode}
          onValueChange={(v) => update({ proxyMode: v as ProxyMode })}
          className="gap-2.5"
        >
          <Choice
            value="system"
            label="Use the system proxy"
            hint="From the HTTP_PROXY, HTTPS_PROXY and NO_PROXY environment variables."
          />
          <Choice value="none" label="No proxy" />
          <Choice value="custom" label="Custom proxy" />
        </RadioGroup>
        {draft.proxyMode === "custom" && (
          <div className="ml-6 flex flex-col gap-3">
            <TextField
              label="Proxy URL"
              hint="http://, https:// or socks5:// with host and port."
              value={draft.proxyUrl}
              onChange={(v) => update({ proxyUrl: v })}
              error={errors.proxyUrl}
              placeholder="http://proxy.example.com:8080"
              mono
            />
            <TextField
              label="User name"
              hint="Leave empty if the proxy doesn't ask for credentials."
              value={draft.proxyUsername}
              onChange={(v) => update({ proxyUsername: v })}
            />
            <PasswordField
              label="Password"
              value={draft.proxyPassword}
              onChange={(v) => update({ proxyPassword: v, clearProxyPassword: false })}
              stored={status?.proxyPassword ?? false}
              locked={status?.locked ?? false}
              cleared={draft.clearProxyPassword}
              onClear={() => update({ proxyPassword: "", clearProxyPassword: true })}
            />
          </div>
        )}
        {draft.proxyMode !== "none" && (
          <BypassField
            value={draft.proxyBypass}
            onChange={(v) => update({ proxyBypass: v })}
            error={errors.proxyBypass}
          />
        )}
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Certificates</h3>
        <PathField
          label="CA certificates"
          hint="A PEM bundle trusted in addition to the system's certificate authorities."
          value={draft.caFile}
          onChange={(v) => update({ caFile: v })}
        />
        <div className="flex flex-col gap-2">
          <div>
            <h4 className="text-sm font-medium">Client certificates</h4>
            <p className="text-xs text-muted-foreground">
              Sent to servers that ask for one. The first certificate whose host matches is used.
            </p>
          </div>
          {draft.certs.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No client certificates. Add one for a host that requires it.
            </p>
          )}
          {draft.certs.map((c, i) => (
            <CertRow
              key={c.id}
              index={i + 1}
              cert={c}
              error={errors.certs?.[c.id]}
              stored={status?.certPassphrases.includes(c.id) ?? false}
              locked={status?.locked ?? false}
              onChange={(patch) => setCert(c.id, patch)}
              onRemove={() => update({ certs: draft.certs.filter((x) => x.id !== c.id) })}
            />
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update({ certs: [...draft.certs, emptyCert()] })}
            >
              <Plus aria-hidden /> Add client certificate
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Choice({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <RadioGroupItem
        id={id}
        value={value}
        className="mt-0.5"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function Hint({ id, error, children }: { id: string; error?: string; children: React.ReactNode }) {
  return (
    <p id={id} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
      {error ?? children}
    </p>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  error,
  placeholder,
  mono,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        spellCheck={false}
        className={cn("h-8", mono && "font-mono text-xs")}
      />
      <Hint id={`${id}-hint`} error={error}>
        {hint}
      </Hint>
    </div>
  );
}

function BypassField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Connect directly to</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        spellCheck={false}
        rows={2}
        placeholder="localhost, *.internal, 10.0.0.0/8"
        className="min-h-14 font-mono text-xs md:text-xs"
      />
      <Hint id={`${id}-hint`} error={error}>
        Host names, *.wildcards, IP addresses or ranges, separated by commas or new lines.
      </Hint>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  stored,
  locked,
  cleared,
  onClear,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** A value is stored on this machine. */
  stored: boolean;
  /** The secret store is locked, so `stored` isn't known. */
  locked: boolean;
  cleared: boolean;
  /** Offers to delete the stored value on save. */
  onClear?: () => void;
}) {
  const id = useId();
  let hint = "Kept in the secret store on this machine, never in settings.";
  if (cleared) hint = "The stored value is removed when you save.";
  else if (value !== "") hint = "Replaces the stored value when you save.";
  else if (locked) hint = "Unlock the secret store to see whether one is stored.";
  else if (stored) hint = "A value is stored on this machine. Type a new one to replace it.";
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={stored && !cleared ? "••••••••" : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
          className="h-8 w-64"
        />
        {stored && !cleared && onClear && (
          <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onClear}>
            Remove stored {label.toLowerCase()}
          </Button>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

function PathField({
  label,
  hint,
  value,
  onChange,
  error,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  const choose = async () => {
    try {
      const p = await api.pickFile();
      if (p) onChange(p);
    } catch {
      // The native dialog failed; the path can still be typed.
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          spellCheck={false}
          placeholder="No file"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          aria-label={`Choose file for ${label}`}
          onClick={() => void choose()}
        >
          <FileUp aria-hidden /> Choose…
        </Button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function CertRow({
  index,
  cert,
  error,
  stored,
  locked,
  onChange,
  onRemove,
}: {
  index: number;
  cert: CertDraft;
  error?: string;
  stored: boolean;
  locked: boolean;
  onChange: (patch: Partial<CertDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const name = `Client certificate ${index}`;
  return (
    <fieldset aria-label={name} className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-host`}>Host</Label>
          <Input
            id={`${id}-host`}
            value={cert.host}
            onChange={(e) => onChange({ host: e.target.value })}
            placeholder="api.example.com or *.example.com"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-error`}
            spellCheck={false}
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-kind`}>Format</Label>
          <Select value={cert.kind} onValueChange={(v) => onChange({ kind: v as CertDraft["kind"] })}>
            <SelectTrigger id={`${id}-kind`} className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pem">PEM certificate and key</SelectItem>
              <SelectItem value="pfx">PKCS#12 (.p12, .pfx)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Remove ${name.toLowerCase()}`}
              onClick={onRemove}
            >
              <Trash2 aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>
      {cert.kind === "pem" ? (
        <>
          <PathField
            label="Certificate file"
            value={cert.certFile}
            onChange={(v) => onChange({ certFile: v })}
          />
          <PathField
            label="Key file"
            hint="An unencrypted PEM private key."
            value={cert.keyFile}
            onChange={(v) => onChange({ keyFile: v })}
          />
        </>
      ) : (
        <>
          <PathField label="PKCS#12 file" value={cert.pfxFile} onChange={(v) => onChange({ pfxFile: v })} />
          <PasswordField
            label="Passphrase"
            value={cert.passphrase}
            onChange={(v) => onChange({ passphrase: v })}
            stored={stored}
            locked={locked}
            cleared={false}
          />
        </>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
