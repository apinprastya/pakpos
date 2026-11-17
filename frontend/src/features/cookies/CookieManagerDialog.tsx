import { useId, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/errors";
import { cookieRef, type StoredCookie } from "@/lib/model";
import { useCookiesStore, filterCookies, groupByDomain } from "@/stores/cookies";
import {
  emptyCookieDraft,
  expiryLabel,
  flagsLabel,
  fromCookieDraft,
  toCookieDraft,
  type CookieDraft,
} from "./cookieForm";

/** The cookie manager: the open workspace's cookies, grouped by domain. */
export function CookieManagerDialog() {
  const open = useCookiesStore((s) => s.open);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && useCookiesStore.getState().close()}>
      {open && <CookieManagerBody />}
    </Dialog>
  );
}

/** What the dialog shows: the list, or the form for a new or existing cookie. */
type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; cookie: StoredCookie };

function CookieManagerBody() {
  const [view, setView] = useState<View>({ kind: "list" });
  const focus = useCookiesStore((s) => s.focusDomain);
  return (
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Cookies</DialogTitle>
        <DialogDescription>
          Sent with requests in this workspace. Cookies with an expiry date are kept on this machine; session
          cookies last until Pakpos quits.
        </DialogDescription>
      </DialogHeader>
      {view.kind === "list" ? (
        <CookieList
          onAdd={() => setView({ kind: "add" })}
          onEdit={(cookie) => setView({ kind: "edit", cookie })}
        />
      ) : (
        <CookieForm
          key={view.kind === "edit" ? `${view.cookie.domain}|${view.cookie.path}|${view.cookie.name}` : "new"}
          editing={view.kind === "edit" ? view.cookie : null}
          initialDomain={focus}
          onDone={() => setView({ kind: "list" })}
        />
      )}
    </DialogContent>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CookieList({ onAdd, onEdit }: { onAdd: () => void; onEdit: (c: StoredCookie) => void }) {
  const cookies = useCookiesStore((s) => s.cookies);
  const loading = useCookiesStore((s) => s.loading);
  const loadError = useCookiesStore((s) => s.error);
  const focus = useCookiesStore((s) => s.focusDomain);
  const [query, setQuery] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const store = useCookiesStore.getState;
  const groups = groupByDomain(filterCookies(cookies, query), focus);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-5 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Filter cookies"
            placeholder="Filter by domain, name or value"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-7"
          />
        </div>
        <Button type="button" size="sm" onClick={onAdd}>
          <Plus aria-hidden /> Add cookie
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cookies.length === 0}
          onClick={() => setConfirmAll(true)}
        >
          Delete all
        </Button>
      </div>
      {confirmAll && (
        <div
          role="alertdialog"
          aria-label="Delete all cookies"
          className="flex items-center gap-3 border-b bg-muted/50 px-5 py-2 text-sm"
        >
          <p className="flex-1">Delete every cookie of this workspace? Requests will start without them.</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirmAll(false);
              void run(() => store().clearAll());
            }}
          >
            Delete all cookies
          </Button>
        </div>
      )}
      {(error ?? loadError) && (
        <p role="alert" className="border-b px-5 py-2 text-xs text-destructive">
          {error ?? `Couldn't load cookies: ${loadError}`}
        </p>
      )}
      <div className="min-h-[240px] flex-1 overflow-y-auto px-5 py-3">
        {groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {loading
              ? "Loading cookies…"
              : query
                ? "No cookies match the filter."
                : "No cookies yet. Cookies that responses set appear here, or add one."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.domain} aria-label={g.domain}>
                <div className="flex items-center gap-2 border-b pb-1">
                  <h3 className="font-mono text-xs font-semibold">{g.domain}</h3>
                  <span className="text-xs text-muted-foreground tabular-nums">{g.cookies.length}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 text-xs"
                    aria-label={`Delete cookies of ${g.domain}`}
                    onClick={() => void run(() => store().clearDomain(g.domain))}
                  >
                    Delete domain
                  </Button>
                </div>
                <table aria-label={`Cookies of ${g.domain}`} className="w-full text-left text-[12.5px]">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Name</th>
                      <th className="py-1 pr-3 font-normal">Value</th>
                      <th className="py-1 pr-3 font-normal">Path</th>
                      <th className="py-1 pr-3 font-normal">Expires</th>
                      <th className="py-1 pr-3 font-normal">Flags</th>
                      <th className="py-1 font-normal">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.cookies.map((c) => (
                      <tr key={`${c.path}|${c.name}`} className="border-b border-border/60 align-top">
                        <td className="py-1 pr-3 font-mono font-medium break-all">{c.name}</td>
                        <td className="selectable max-w-64 py-1 pr-3 font-mono break-all text-muted-foreground">
                          {c.value}
                        </td>
                        <td className="py-1 pr-3 font-mono">{c.path}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{expiryLabel(c)}</td>
                        <td className="py-1 pr-3 text-muted-foreground">
                          {[!c.hostOnly && "Subdomains", flagsLabel(c)].filter(Boolean).join(", ") || "—"}
                        </td>
                        <td className="py-0.5 whitespace-nowrap">
                          <IconButton label={`Edit cookie ${c.name}`} onClick={() => onEdit(c)}>
                            <Pencil aria-hidden />
                          </IconButton>
                          <IconButton
                            label={`Delete cookie ${c.name}`}
                            onClick={() => void run(() => store().remove(c))}
                          >
                            <Trash2 aria-hidden />
                          </IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CookieForm({
  editing,
  initialDomain,
  onDone,
}: {
  editing: StoredCookie | null;
  initialDomain: string;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<CookieDraft>(() =>
    editing ? toCookieDraft(editing) : emptyCookieDraft(initialDomain),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const set = (patch: Partial<CookieDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const onSave = async () => {
    const parsed = fromCookieDraft(draft);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      const store = useCookiesStore.getState();
      if (editing) await store.update(cookieRef(editing), parsed.cookie);
      else await store.add(parsed.cookie);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: "name" | "value" | "domain" | "path", label: string, mono = true) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        spellCheck={false}
        className={mono ? "h-8 font-mono text-xs" : "h-8"}
      />
    </div>
  );
  const check = (key: "subdomains" | "secure" | "httpOnly", label: string) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`${id}-${key}`}
        checked={draft[key]}
        onCheckedChange={(v) => set({ [key]: v === true })}
      />
      <Label htmlFor={`${id}-${key}`} className="font-normal">
        {label}
      </Label>
    </div>
  );

  return (
    <form
      aria-label={editing ? "Edit cookie" : "Add cookie"}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <div className="grid flex-1 grid-cols-2 gap-x-4 gap-y-3 overflow-y-auto px-5 py-4">
        <h3 className="col-span-2 text-sm font-semibold">
          {editing ? `Edit ${editing.name}` : "New cookie"}
        </h3>
        {field("name", "Name")}
        {field("domain", "Domain")}
        <div className="col-span-2">{field("value", "Value")}</div>
        {field("path", "Path")}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-lifetime`}>Expires</Label>
          <div className="flex items-center gap-2">
            <Select
              value={draft.lifetime}
              onValueChange={(v) => set({ lifetime: v as CookieDraft["lifetime"] })}
            >
              <SelectTrigger id={`${id}-lifetime`} className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">On a date</SelectItem>
                <SelectItem value="session">When Pakpos quits</SelectItem>
              </SelectContent>
            </Select>
            {draft.lifetime === "date" && (
              <Input
                type="datetime-local"
                aria-label="Expiry date"
                value={draft.expires}
                onChange={(e) => set({ expires: e.target.value })}
                className="h-8 min-w-0 flex-1"
              />
            )}
          </div>
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2">
          {check("subdomains", "Include subdomains")}
          {check("secure", "Secure (HTTPS only)")}
          {check("httpOnly", "HttpOnly")}
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-samesite`} className="font-normal">
              SameSite
            </Label>
            <Select
              value={draft.sameSite || "default"}
              onValueChange={(v) => set({ sameSite: v === "default" ? "" : (v as CookieDraft["sameSite"]) })}
            >
              <SelectTrigger id={`${id}-samesite`} className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Not set</SelectItem>
                <SelectItem value="lax">Lax</SelectItem>
                <SelectItem value="strict">Strict</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="border-t px-5 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t px-5 py-3">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save cookie"}
        </Button>
      </div>
    </form>
  );
}
