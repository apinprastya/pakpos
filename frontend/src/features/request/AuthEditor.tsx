import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VarInput } from "@/components/editor/VarInput";
import { emptyOAuth2, type APIKeyLocation, type Auth, type AuthType } from "@/lib/model";
import { cn } from "@/lib/utils";
import { AUTH_LABELS, isLiteralSecret, secretFieldValue, type SecretField } from "./auth";
import { Field, LiteralHint, SecretInput, fieldClass } from "./authFields";
import { OAuth2Fields } from "./OAuth2Fields";
import { OAuth2Token } from "./OAuth2Token";

const ORDER: AuthType[] = ["none", "inherit", "basic", "bearer", "apikey", "oauth2"];

export interface AuthEditorProps {
  auth: Auth;
  onChange: (update: (auth: Auth) => Auth) => void;
  /** Offer `inherit` (requests and folders; a collection has nothing above it). */
  allowInherit: boolean;
  /** Explains what `inherit` resolves to. */
  inheritInfo?: React.ReactNode;
  /** Explains what `none` means here. */
  noneInfo?: string;
  /** Offered on literal values in secret fields; omit to hide the hint. */
  onMoveToSecret?: (field: SecretField, value: string) => void;
  /**
   * Who owns an OAuth 2.0 token got here: the request, folder or collection id
   * ("" for an unsaved request) and a draft's parent, for {{variables}}.
   */
  tokenOwner?: { ownerId: string; parentId: string };
}

/** The auth type and its fields, shared by requests and collection/folder settings. */
export function AuthEditor({
  auth,
  onChange,
  allowInherit,
  inheritInfo,
  noneInfo = "No authorization is sent.",
  onMoveToSecret,
  tokenOwner,
}: AuthEditorProps) {
  const set = (patch: Partial<Auth>) => onChange((a) => ({ ...a, ...patch }));
  const setType = (type: AuthType) =>
    onChange((a) => ({ ...a, type, ...(type === "oauth2" && !a.oauth2 ? { oauth2: emptyOAuth2() } : {}) }));
  const types = ORDER.filter((t) => allowInherit || t !== "inherit");
  const hint = (field: SecretField) => {
    const value = secretFieldValue(auth, field);
    return onMoveToSecret && isLiteralSecret(value) ? (
      <LiteralHint onMove={() => onMoveToSecret(field, value)} />
    ) : null;
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="auth-type" label="Type">
        <Select value={auth.type} onValueChange={(v) => setType(v as AuthType)}>
          <SelectTrigger id="auth-type" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {AUTH_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {auth.type === "none" && <p className="text-xs text-muted-foreground">{noneInfo}</p>}
      {auth.type === "inherit" && inheritInfo}
      {auth.type === "basic" && (
        <>
          <Field id="auth-username" label="Username">
            <VarInput
              id="auth-username"
              ariaLabel="Username"
              className={fieldClass}
              value={auth.username}
              onChange={(username) => set({ username })}
            />
          </Field>
          <Field id="auth-password" label="Password" hint={hint("password")}>
            <SecretInput
              id="auth-password"
              label="Password"
              value={auth.password}
              onChange={(password) => set({ password })}
            />
          </Field>
        </>
      )}
      {auth.type === "bearer" && (
        <>
          <Field id="auth-token" label="Token" hint={hint("token")}>
            <SecretInput
              id="auth-token"
              label="Token"
              value={auth.token}
              onChange={(token) => set({ token })}
            />
          </Field>
          <Field id="auth-prefix" label="Prefix">
            <VarInput
              id="auth-prefix"
              ariaLabel="Prefix"
              className={cn(fieldClass, "w-40")}
              placeholder="Bearer"
              value={auth.prefix}
              onChange={(prefix) => set({ prefix })}
            />
          </Field>
        </>
      )}
      {auth.type === "apikey" && (
        <>
          <Field id="auth-key" label="Key">
            <VarInput
              id="auth-key"
              ariaLabel="Key"
              className={fieldClass}
              placeholder="X-API-Key"
              value={auth.apiKey}
              onChange={(apiKey) => set({ apiKey })}
            />
          </Field>
          <Field id="auth-value" label="Value" hint={hint("apiValue")}>
            <SecretInput
              id="auth-value"
              label="Value"
              value={auth.apiValue}
              onChange={(apiValue) => set({ apiValue })}
            />
          </Field>
          <Field id="auth-in" label="Send in">
            <Select value={auth.apiIn} onValueChange={(v) => set({ apiIn: v as APIKeyLocation })}>
              <SelectTrigger id="auth-in" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="header">Header</SelectItem>
                <SelectItem value="query">Query parameter</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
      {auth.type === "oauth2" && (
        <>
          <OAuth2Fields
            oauth2={auth.oauth2 ?? emptyOAuth2()}
            onChange={(patch) =>
              onChange((a) => ({ ...a, oauth2: { ...(a.oauth2 ?? emptyOAuth2()), ...patch } }))
            }
            hint={hint}
          />
          {tokenOwner && (
            <OAuth2Token ownerId={tokenOwner.ownerId} parentId={tokenOwner.parentId} auth={auth} />
          )}
        </>
      )}
      {auth.type !== "none" && auth.type !== "inherit" && (
        <p className="text-xs text-muted-foreground">
          A header or query parameter you add yourself with the same name takes priority.
        </p>
      )}
    </div>
  );
}
