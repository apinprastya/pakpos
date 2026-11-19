import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VarInput } from "@/components/editor/VarInput";
import type { OAuth2, OAuth2Grant } from "@/lib/model";
import { cn } from "@/lib/utils";
import { Field, SecretInput, fieldClass } from "./authFields";
import { KeyValueTable } from "./KeyValueTable";
import { DEFAULT_CALLBACK, GRANTS, GRANT_LABELS, callbackProblem, fieldsFor, grantOf } from "./oauth2";
import type { SecretField } from "./auth";

interface Props {
  oauth2: OAuth2;
  onChange: (patch: Partial<OAuth2>) => void;
  /** The "Move to secret variable" hint under a literal secret, or null. */
  hint: (field: SecretField) => React.ReactNode;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Callback URL copied");
  } catch {
    toast.error("Couldn't copy the callback URL", { description: "The clipboard isn't available." });
  }
}

function Text({
  id,
  label,
  value,
  placeholder,
  onChange,
  className,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <Field id={id} label={label}>
      <VarInput
        id={id}
        ariaLabel={label}
        className={cn(fieldClass, className)}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    </Field>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

/** The OAuth 2.0 settings, showing only what the grant type uses. */
export function OAuth2Fields({ oauth2: o, onChange, hint }: Props) {
  const grant = grantOf(o);
  const f = fieldsFor(grant);
  const fixed = o.redirectUrl !== "";
  const callbackError = callbackProblem(o.redirectUrl);

  return (
    <>
      <Field id="oauth2-grant" label="Grant type">
        <Select value={grant} onValueChange={(v) => onChange({ grant: v as OAuth2Grant })}>
          <SelectTrigger id="oauth2-grant" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRANTS.map((g) => (
              <SelectItem key={g} value={g}>
                {GRANT_LABELS[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {grant === "implicit" && (
        <p className="text-xs text-muted-foreground">
          The implicit grant is deprecated. Use the authorization code grant with PKCE if the provider
          supports it.
        </p>
      )}
      {f.authUrl && (
        <Text
          id="oauth2-auth-url"
          label="Auth URL"
          placeholder="https://auth.example.com/authorize"
          value={o.authUrl}
          onChange={(authUrl) => onChange({ authUrl })}
        />
      )}
      {f.tokenUrl && (
        <Text
          id="oauth2-token-url"
          label="Token URL"
          placeholder="https://auth.example.com/oauth/token"
          value={o.tokenUrl}
          onChange={(tokenUrl) => onChange({ tokenUrl })}
        />
      )}
      {f.callback && (
        <Field
          id="oauth2-callback"
          label="Callback"
          hint={
            fixed ? (
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                {callbackError ? (
                  <span role="alert" className="text-destructive">
                    {callbackError}
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-x-1">
                    Register <span className="font-mono text-foreground">{o.redirectUrl}</span> as a redirect
                    URI with the provider.
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Copy callback URL"
                      title="Copy callback URL"
                      onClick={() => copyText(o.redirectUrl)}
                    >
                      <Copy />
                    </Button>
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Pakpos listens on http://127.0.0.1 with a random port and /callback. Use this when the
                provider accepts any loopback port (RFC 8252); otherwise choose a fixed port.
              </p>
            )
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <Select
              value={fixed ? "fixed" : "random"}
              onValueChange={(v) => onChange({ redirectUrl: v === "fixed" ? DEFAULT_CALLBACK : "" })}
            >
              <SelectTrigger id="oauth2-callback" aria-label="Callback" className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random port</SelectItem>
                <SelectItem value="fixed">Fixed URL</SelectItem>
              </SelectContent>
            </Select>
            {fixed && (
              <VarInput
                id="oauth2-callback-url"
                ariaLabel="Callback URL"
                className={fieldClass}
                value={o.redirectUrl}
                onChange={(redirectUrl) => onChange({ redirectUrl: redirectUrl || DEFAULT_CALLBACK })}
              />
            )}
          </div>
        </Field>
      )}
      <Text
        id="oauth2-client-id"
        label="Client ID"
        value={o.clientId}
        onChange={(clientId) => onChange({ clientId })}
      />
      {f.clientSecret && (
        <Field id="oauth2-client-secret" label="Client secret" hint={hint("oauth2ClientSecret")}>
          <SecretInput
            id="oauth2-client-secret"
            label="Client secret"
            value={o.clientSecret}
            onChange={(clientSecret) => onChange({ clientSecret })}
          />
        </Field>
      )}
      {f.credentials && (
        <>
          <Text
            id="oauth2-username"
            label="Username"
            value={o.username}
            onChange={(username) => onChange({ username })}
          />
          <Field id="oauth2-password" label="Password" hint={hint("oauth2Password")}>
            <SecretInput
              id="oauth2-password"
              label="Password"
              value={o.password}
              onChange={(password) => onChange({ password })}
            />
          </Field>
        </>
      )}
      <Text
        id="oauth2-scope"
        label="Scope"
        placeholder="read write"
        value={o.scope}
        onChange={(scope) => onChange({ scope })}
      />
      {f.clientAuth && (
        <Field id="oauth2-client-auth" label="Client auth">
          <Select
            value={o.clientAuth || "basic"}
            onValueChange={(v) => onChange({ clientAuth: v as OAuth2["clientAuth"] })}
          >
            <SelectTrigger id="oauth2-client-auth" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">Basic auth header</SelectItem>
              <SelectItem value="body">Client ID and secret in the body</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {f.pkce && (
        <Field id="oauth2-pkce" label="PKCE">
          <div className="flex flex-wrap items-center gap-3">
            <Check
              label="Use PKCE"
              checked={!o.disablePkce}
              onChange={(v) => onChange({ disablePkce: !v })}
            />
            {!o.disablePkce && (
              <Select
                value={o.pkceMethod || "S256"}
                onValueChange={(v) => onChange({ pkceMethod: v as OAuth2["pkceMethod"] })}
              >
                <SelectTrigger id="oauth2-pkce" aria-label="PKCE method" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="S256">SHA-256 (S256)</SelectItem>
                  <SelectItem value="plain">Plain (not recommended)</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        </Field>
      )}
      <Field id="oauth2-placement" label="Send token">
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={o.placement || "header"}
            onValueChange={(v) => onChange({ placement: v as OAuth2["placement"] })}
          >
            <SelectTrigger id="oauth2-placement" className="w-40 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="header">In a header</SelectItem>
              <SelectItem value="query">In the query</SelectItem>
            </SelectContent>
          </Select>
          {o.placement === "query" ? (
            <VarInput
              id="oauth2-query-param"
              ariaLabel="Query parameter"
              className={cn(fieldClass, "w-40")}
              placeholder="access_token"
              value={o.queryParam}
              onChange={(queryParam) => onChange({ queryParam })}
            />
          ) : (
            <VarInput
              id="oauth2-prefix"
              ariaLabel="Header prefix"
              className={cn(fieldClass, "w-40")}
              placeholder="Bearer"
              value={o.headerPrefix}
              onChange={(headerPrefix) => onChange({ headerPrefix })}
            />
          )}
        </div>
      </Field>
      {f.refresh && (
        <Field id="oauth2-refresh" label="Refresh">
          <Check
            label="Refresh the token before a send when it expires within 30 seconds"
            checked={!o.disableAutoRefresh}
            onChange={(v) => onChange({ disableAutoRefresh: !v })}
          />
        </Field>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Extra parameters (audience, resource…)</span>
        <KeyValueTable
          rows={o.extraParams}
          onChange={(extraParams) => onChange({ extraParams })}
          label="Extra OAuth 2.0 parameters"
          keyPlaceholder="audience"
        />
      </div>
    </>
  );
}
