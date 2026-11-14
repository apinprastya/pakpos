import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VarInput } from "@/components/editor/VarInput";
import type { APIKeyLocation, Auth, AuthType } from "@/lib/model";
import { cn } from "@/lib/utils";
import { AUTH_LABELS, isLiteralSecret, isReferenceOnly, type SecretField } from "./auth";

const ORDER: AuthType[] = ["none", "inherit", "basic", "bearer", "apikey"];

/** Plain auth fields look like inputs, with {{variable}} support. */
const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-input px-2.5 text-[12.5px] hover:bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30";

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
}

/** The auth type and its fields, shared by requests and collection/folder settings. */
export function AuthEditor({
  auth,
  onChange,
  allowInherit,
  inheritInfo,
  noneInfo = "No authorization is sent.",
  onMoveToSecret,
}: AuthEditorProps) {
  const set = (patch: Partial<Auth>) => onChange((a) => ({ ...a, ...patch }));
  const types = ORDER.filter((t) => allowInherit || t !== "inherit");
  const hint = (field: SecretField) =>
    onMoveToSecret && isLiteralSecret(auth[field]) ? (
      <LiteralHint onMove={() => onMoveToSecret(field, auth[field])} />
    ) : null;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="auth-type" label="Type">
        <Select value={auth.type} onValueChange={(v) => set({ type: v as AuthType })}>
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
      {auth.type !== "none" && auth.type !== "inherit" && (
        <p className="text-xs text-muted-foreground">
          A header or query parameter you add yourself with the same name takes priority.
        </p>
      )}
    </div>
  );
}

function LiteralHint({ onMove }: { onMove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>This value is saved in the file as plain text.</span>
      <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onMove}>
        <KeyRound /> Move to secret variable
      </Button>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <Label
        htmlFor={id}
        className="text-xs text-muted-foreground"
        // A variable field isn't a labelable element, so focus it by hand.
        onClick={() => {
          const el = document.getElementById(id);
          if (el?.dataset.slot === "var-input") el.focus();
        }}
      >
        {label}
      </Label>
      {children}
      {hint && <div className="col-start-2">{hint}</div>}
    </div>
  );
}

/**
 * A field that usually holds a secret. A literal is masked (with show/hide);
 * a value that is only `{{references}}` (or is being typed as one) is a
 * variable field with highlighting, hover and autocomplete. When typing
 * switches between the two, focus moves to the new field, caret at the end.
 */
function SecretInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const reference = isReferenceOnly(value);
  // Set when the user's own typing switches the mode, so focus follows.
  const refocus = useRef(false);
  const change = (next: string) => {
    if (isReferenceOnly(next) !== reference) refocus.current = true;
    onChange(next);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const el = document.getElementById(id);
    el?.focus();
    if (el instanceof HTMLInputElement) el.setSelectionRange(el.value.length, el.value.length);
  }, [reference, id]);

  return reference ? (
    <VarInput id={id} ariaLabel={label} className={fieldClass} value={value} onChange={change} />
  ) : (
    <MaskedInput id={id} value={value} onChange={change} />
  );
}

function MaskedInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        className="pr-9 font-mono"
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label={shown ? "Hide value" : "Show value"}
        aria-pressed={shown}
        title={shown ? "Hide value" : "Show value"}
        onClick={() => setShown(!shown)}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
