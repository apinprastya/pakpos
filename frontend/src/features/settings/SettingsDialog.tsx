import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  Globe,
  Info,
  KeyRound,
  Network,
  Palette,
  History,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { DEFAULT_SETTINGS, type AppSettings, type BuildInfo } from "@/lib/model";
import { cn } from "@/lib/utils";
import { useSettingsStore, type SettingsSection } from "@/stores/settings";
import { useSecretsStore } from "@/stores/secrets";
import { useUpdateStore } from "@/stores/update";
import { SecretsSection } from "@/features/secrets/SecretsControls";
import { NetworkSection } from "./NetworkSection";
import { WebhooksSettings } from "@/features/webhooks/WebhooksSettings";
import {
  fromDraft,
  hasPendingSecrets,
  lowersRetention,
  toDraft,
  type DraftErrors,
  type PendingSecrets,
  type SettingsDraft,
} from "./settingsForm";

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "requests", label: "Requests", icon: Network },
  { id: "network", label: "Network", icon: Globe },
  { id: "history", label: "History", icon: History },
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "about", label: "About", icon: Info },
];

/** App settings. Edits apply when saved; Cancel discards them. */
export function SettingsDialog() {
  const open = useSettingsStore((s) => s.dialogOpen);
  const close = useSettingsStore((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {open && <SettingsDialogBody />}
    </Dialog>
  );
}

function SettingsDialogBody() {
  const section = useSettingsStore((s) => s.section);
  const setSection = useSettingsStore((s) => s.setSection);
  const stored = useSettingsStore((s) => s.settings);
  const save = useSettingsStore((s) => s.save);
  const close = useSettingsStore((s) => s.closeDialog);

  // Start from what Go has now, in case it changed since load.
  const [saved, setSaved] = useState<AppSettings>(stored);
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(stored));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let live = true;
    api.getSettings().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setDraft(toDraft(s));
      },
      () => {},
    );
    api.buildInfo().then(
      (b) => live && setBuild(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const update = (patch: Partial<SettingsDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setFormError(null);
  };

  const onSave = async () => {
    // The cloudflared path changes in the Webhooks section right away; keep it.
    const parsed = fromDraft(draft, {
      ...saved,
      cloudflaredPath: useSettingsStore.getState().settings.cloudflaredPath,
    });
    if (parsed.errors) {
      setErrors(parsed.errors);
      // Jump to the section with the first problem.
      setSection(firstSectionWithError(parsed.errors));
      return;
    }
    setErrors({});
    // Passwords go to the secret store, which may need its master password first.
    if (hasPendingSecrets(parsed.secrets) && !(await useSecretsStore.getState().ensureReady())) {
      setFormError("Nothing was saved: the secret store must be unlocked to store passwords.");
      return;
    }
    setSaving(true);
    try {
      await save(parsed.settings);
    } catch (e) {
      setFormError(errorMessage(e));
      setSaving(false);
      return;
    }
    try {
      await storeSecrets(parsed.secrets);
    } catch (e) {
      // The settings are saved; only the password is missing. Stay open to retry.
      const next = useSettingsStore.getState().settings;
      setSaved(next);
      setDraft((d) => ({
        ...toDraft(next),
        proxyPassword: d.proxyPassword,
        certs: keepPassphrases(toDraft(next).certs, d),
      }));
      setFormError(`Settings saved, but a password couldn't be stored: ${errorMessage(e)}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    toast.success("Settings saved");
    close();
  };

  const onReset = async () => {
    let defaults = DEFAULT_SETTINGS;
    try {
      defaults = await api.defaultSettings();
    } catch {
      // Fall back to the built-in copy of the defaults.
    }
    setDraft(toDraft(defaults));
    setErrors({});
    setFormError(null);
  };

  return (
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Changes apply when you save.</DialogDescription>
      </DialogHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <div className="flex min-h-0 min-h-[340px] flex-1">
          <nav aria-label="Settings sections" className="w-40 shrink-0 border-r bg-sidebar p-2">
            <ul className="flex flex-col gap-0.5">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={section === id ? "page" : undefined}
                    onClick={() => setSection(id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      section === id && "bg-sidebar-accent font-medium text-foreground",
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {label}
                    {sectionHasError(id, errors) && (
                      <>
                        <span aria-hidden className="ml-auto size-1.5 rounded-full bg-destructive" />
                        <span className="sr-only">, has errors</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {section === "appearance" && <AppearanceSection draft={draft} update={update} />}
            {section === "requests" && <RequestsSection draft={draft} update={update} errors={errors} />}
            {section === "network" && <NetworkSection draft={draft} update={update} errors={errors} />}
            {section === "history" && (
              <HistorySection draft={draft} update={update} errors={errors} saved={saved} />
            )}
            {section === "secrets" && <SecretsSection />}
            {section === "webhooks" && <WebhooksSettings />}
            {section === "about" && <AboutSection build={build} draft={draft} update={update} />}
          </div>
        </div>
        {formError && (
          <p role="alert" className="border-t px-5 py-2 text-xs text-destructive">
            {formError}
          </p>
        )}
        <DialogFooter className="mx-0 mb-0 flex-row items-center rounded-b-xl border-t px-5 py-3 sm:justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => void onReset()}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function sectionHasError(id: SettingsSection, errors: DraftErrors): boolean {
  if (id === "requests")
    return Boolean(errors.timeoutSeconds || errors.maxRedirects || errors.scriptTimeoutSeconds);
  if (id === "network") return Boolean(errors.proxyUrl || errors.proxyBypass || errors.certs);
  if (id === "history") return Boolean(errors.historyRetention);
  return false;
}

function firstSectionWithError(errors: DraftErrors): SettingsSection {
  return (
    (["requests", "network", "history"] as const).find((id) => sectionHasError(id, errors)) ?? "requests"
  );
}

/** Stores (or deletes, for "") the passwords typed in the Network section. */
async function storeSecrets(secrets: PendingSecrets): Promise<void> {
  if (secrets.proxyPassword !== undefined) await api.setProxyPassword(secrets.proxyPassword);
  for (const { id, passphrase } of secrets.certPassphrases) await api.setCertPassphrase(id, passphrase);
}

/** Carries typed passphrases over to rows reloaded from Go. */
function keepPassphrases(certs: SettingsDraft["certs"], from: SettingsDraft): SettingsDraft["certs"] {
  return certs.map((c) => ({ ...c, passphrase: from.certs.find((x) => x.id === c.id)?.passphrase ?? "" }));
}

interface SectionProps {
  draft: SettingsDraft;
  update: (patch: Partial<SettingsDraft>) => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold">{children}</h3>;
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

function AppearanceSection({ draft, update }: SectionProps) {
  return (
    <section aria-labelledby="settings-appearance" className="flex flex-col gap-6">
      <div>
        <SectionTitle>
          <span id="settings-appearance">Theme</span>
        </SectionTitle>
        <RadioGroup
          aria-label="Theme"
          value={draft.theme}
          onValueChange={(v) => update({ theme: v as SettingsDraft["theme"] })}
          className="gap-2.5"
        >
          <Choice value="light" label="Light" />
          <Choice value="dark" label="Dark" />
          <Choice value="system" label="Match system" hint="Follows your operating system's setting." />
        </RadioGroup>
      </div>
      <div>
        <SectionTitle>Response position</SectionTitle>
        <RadioGroup
          aria-label="Response position"
          value={draft.layout}
          onValueChange={(v) => update({ layout: v as SettingsDraft["layout"] })}
          className="gap-2.5"
        >
          <Choice value="vertical" label="Below the request" />
          <Choice value="horizontal" label="Beside the request" hint="Works best on wide windows." />
        </RadioGroup>
      </div>
    </section>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  error,
  suffix,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="h-8 w-28 tabular-nums"
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? hint}
      </p>
    </div>
  );
}

function SwitchField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} />
    </div>
  );
}

function RequestsSection({ draft, update, errors }: SectionProps & { errors: DraftErrors }) {
  return (
    <section aria-label="Requests" className="flex flex-col gap-5">
      <NumberField
        label="Timeout"
        hint="How long to wait for a whole request. 0 waits with no limit."
        suffix="seconds"
        value={draft.timeoutSeconds}
        onChange={(v) => update({ timeoutSeconds: v })}
        error={errors.timeoutSeconds}
      />
      <SwitchField
        label="Follow redirects"
        hint="Send the request again to the address in a 3xx response."
        checked={draft.followRedirects}
        onChange={(v) => update({ followRedirects: v })}
      />
      <NumberField
        label="Maximum redirects"
        hint="Stop after this many redirects in a row."
        value={draft.maxRedirects}
        onChange={(v) => update({ maxRedirects: v })}
        error={errors.maxRedirects}
        disabled={!draft.followRedirects}
      />
      <SwitchField
        label="Verify TLS certificates"
        hint="Reject servers whose certificate isn't trusted."
        checked={draft.verifyTls}
        onChange={(v) => update({ verifyTls: v })}
      />
      {!draft.verifyTls && (
        <div
          role="note"
          className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
          <p>
            Pakpos will accept any certificate, including self-signed and expired ones. Turn this back on when
            you're done testing.
          </p>
        </div>
      )}
      <NumberField
        label="Script timeout"
        hint="Stop a pre-request or test script that runs longer (1 to 60 seconds)."
        suffix="seconds"
        value={draft.scriptTimeoutSeconds}
        onChange={(v) => update({ scriptTimeoutSeconds: v })}
        error={errors.scriptTimeoutSeconds}
      />
    </section>
  );
}

function HistorySection({
  draft,
  update,
  errors,
  saved,
}: SectionProps & { errors: DraftErrors; saved: AppSettings }) {
  return (
    <section aria-label="History" className="flex flex-col gap-5">
      <NumberField
        label="Requests to keep"
        hint="Per workspace. Older entries are deleted. 0 keeps everything."
        suffix="entries"
        value={draft.historyRetention}
        onChange={(v) => update({ historyRetention: v })}
        error={errors.historyRetention}
      />
      {!errors.historyRetention && lowersRetention(draft, saved) && (
        <p role="note" className="text-xs text-muted-foreground">
          Saving deletes everything older than the newest {draft.historyRetention.trim()} entries in each
          workspace.
        </p>
      )}
    </section>
  );
}

function AboutSection({ build, draft, update }: SectionProps & { build: BuildInfo | null }) {
  const checkNow = () => {
    // One dialog at a time: the update dialog replaces settings.
    useSettingsStore.getState().closeDialog();
    void useUpdateStore.getState().check();
  };
  // [label, value, isCode]
  const rows: [string, string, boolean][] = build
    ? [
        ["Version", build.version, true],
        ["Commit", build.commit || "Not recorded", Boolean(build.commit)],
        ["Platform", `${build.os}/${build.arch}`, true],
        ["License", "Apache License 2.0", false],
      ]
    : [];
  return (
    <section aria-label="About" className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">About Pakpos</h3>
        <p className="mt-1 text-xs text-muted-foreground">A desktop client for testing REST APIs.</p>
      </div>
      {build ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, v, code]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className={cn("selectable", code && "font-mono text-xs leading-5")}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">Loading version details…</p>
      )}
      <div className="flex flex-col gap-3 border-t pt-4">
        <SwitchField
          label="Check for updates automatically"
          hint="Looks for a new release at startup and once a day. Pakpos only installs one when you ask."
          checked={draft.checkForUpdates}
          onChange={(v) => update({ checkForUpdates: v })}
        />
        <div>
          <Button type="button" variant="outline" size="sm" onClick={checkNow}>
            Check for updates now
          </Button>
        </div>
      </div>
    </section>
  );
}
