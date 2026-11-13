import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { APIKeyLocation, Auth, AuthType, Request } from "@/lib/model";

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: "none", label: "No auth" },
  { value: "inherit", label: "Inherit from collection" },
  { value: "basic", label: "Basic auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "apikey", label: "API key" },
];

interface Props {
  request: Request;
  onChange: (update: (req: Request) => Request) => void;
}

export function AuthSection({ request, onChange }: Props) {
  const auth = request.auth;
  const set = (patch: Partial<Auth>) => onChange((r) => ({ ...r, auth: { ...r.auth, ...patch } }));

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="auth-type" label="Type">
        <Select value={auth.type} onValueChange={(v) => set({ type: v as AuthType })}>
          <SelectTrigger id="auth-type" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {auth.type === "none" && <p className="text-xs text-muted-foreground">No authorization is sent.</p>}
      {auth.type === "inherit" && (
        <p className="text-xs text-muted-foreground">
          Uses the auth set on the collection. Collection auth isn&apos;t supported yet, so nothing is sent
          for now.
        </p>
      )}
      {auth.type === "basic" && (
        <>
          <Field id="auth-username" label="Username">
            <Input
              id="auth-username"
              className="font-mono"
              value={auth.username}
              spellCheck={false}
              onChange={(e) => set({ username: e.target.value })}
            />
          </Field>
          <Field id="auth-password" label="Password">
            <SecretInput
              id="auth-password"
              value={auth.password}
              onChange={(password) => set({ password })}
            />
          </Field>
        </>
      )}
      {auth.type === "bearer" && (
        <>
          <Field id="auth-token" label="Token">
            <SecretInput id="auth-token" value={auth.token} onChange={(token) => set({ token })} />
          </Field>
          <Field id="auth-prefix" label="Prefix">
            <Input
              id="auth-prefix"
              className="w-40 font-mono"
              placeholder="Bearer"
              value={auth.prefix}
              spellCheck={false}
              onChange={(e) => set({ prefix: e.target.value })}
            />
          </Field>
        </>
      )}
      {auth.type === "apikey" && (
        <>
          <Field id="auth-key" label="Key">
            <Input
              id="auth-key"
              className="font-mono"
              placeholder="X-API-Key"
              value={auth.apiKey}
              spellCheck={false}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </Field>
          <Field id="auth-value" label="Value">
            <SecretInput id="auth-value" value={auth.apiValue} onChange={(apiValue) => set({ apiValue })} />
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

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function SecretInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
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
        onClick={() => setShown(!shown)}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
