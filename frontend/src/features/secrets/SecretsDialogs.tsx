import { useId, useState } from "react";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useSecretsStore } from "@/stores/secrets";
import { newPasswordError, passwordStrength } from "./password";

/** The master password dialogs, opened through `useSecretsStore` (file store only). */
export function SecretsDialogs() {
  const dialog = useSecretsStore((s) => s.dialog);
  const close = useSecretsStore((s) => s.closeDialog);
  const onOpenChange = (open: boolean) => !open && close(false);
  return (
    <>
      <Dialog open={dialog === "set-password"} onOpenChange={onOpenChange}>
        {dialog === "set-password" && <SetPasswordBody />}
      </Dialog>
      <Dialog open={dialog === "unlock"} onOpenChange={onOpenChange}>
        {dialog === "unlock" && <UnlockBody />}
      </Dialog>
      <Dialog open={dialog === "change-password"} onOpenChange={onOpenChange}>
        {dialog === "change-password" && <ChangePasswordBody />}
      </Dialog>
      <AlertDialog open={dialog === "reset"} onOpenChange={onOpenChange}>
        {dialog === "reset" && <ResetBody />}
      </AlertDialog>
    </>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoFocus,
  describedBy,
  autoComplete = "new-password",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  describedBy?: string;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        value={value}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

const strengthClass = {
  "too-short": "text-muted-foreground",
  weak: "text-status-client",
  fair: "text-status-redirect",
  strong: "text-status-ok",
};

/** A new password with confirmation and a strength hint (set and change). */
function NewPassword({
  password,
  confirm,
  setPassword,
  setConfirm,
  autoFocus,
  label = "Master password",
}: {
  password: string;
  confirm: string;
  setPassword: (v: string) => void;
  setConfirm: (v: string) => void;
  autoFocus?: boolean;
  label?: string;
}) {
  const hintId = useId();
  const strength = passwordStrength(password);
  return (
    <>
      <PasswordField
        label={label}
        value={password}
        onChange={setPassword}
        autoFocus={autoFocus}
        describedBy={hintId}
      />
      <p id={hintId} aria-live="polite" className={cn("-mt-2 text-xs", strengthClass[strength.strength])}>
        {password ? strength.label : "Use at least 8 characters; a long passphrase is easiest to remember."}
      </p>
      <PasswordField label={`Confirm ${label.toLowerCase()}`} value={confirm} onChange={setConfirm} />
    </>
  );
}

function ForgetWarning() {
  return (
    <div className="flex gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-status-client" />
      <p>
        If you forget this password, the secret values stored with it can&apos;t be recovered. You&apos;d have
        to reset the secret store and enter them again.
      </p>
    </div>
  );
}

function SetPasswordBody() {
  const store = useSecretsStore.getState;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = newPasswordError(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await store().setPassword(password);
      toast.success("Master password set");
      store().closeDialog(true);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Set a master password</DialogTitle>
          <DialogDescription>
            This machine has no system keychain, so secret values are kept in an encrypted file. The master
            password unlocks it once per session.
          </DialogDescription>
        </DialogHeader>
        <NewPassword
          password={password}
          confirm={confirm}
          setPassword={(v) => {
            setPassword(v);
            setError(null);
          }}
          setConfirm={(v) => {
            setConfirm(v);
            setError(null);
          }}
          autoFocus
        />
        <ForgetWarning />
        <FormError message={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => store().closeDialog(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Setting…" : "Set password"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function UnlockBody() {
  const store = useSecretsStore.getState;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password) {
      setError("Enter your master password.");
      return;
    }
    setBusy(true);
    try {
      await store().unlock(password);
      store().closeDialog(true);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Unlock secrets</DialogTitle>
          <DialogDescription>
            Enter your master password to use secret variables. They stay unlocked until you quit Pakpos or
            lock them.
          </DialogDescription>
        </DialogHeader>
        <PasswordField
          label="Master password"
          value={password}
          autoFocus
          autoComplete="current-password"
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
        />
        <FormError message={error} />
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => store().openDialog("reset")}>
            Reset secret store…
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => store().closeDialog(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ChangePasswordBody() {
  const store = useSecretsStore.getState;
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError(null);
  };

  const submit = async () => {
    if (!current) {
      setError("Enter your current master password.");
      return;
    }
    const problem = newPasswordError(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await store().changePassword(current, password);
      toast.success("Master password changed");
      store().closeDialog(true);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Change master password</DialogTitle>
          <DialogDescription>
            Your stored secret values are encrypted again with the new password.
          </DialogDescription>
        </DialogHeader>
        <PasswordField
          label="Current password"
          value={current}
          autoFocus
          autoComplete="current-password"
          onChange={edit(setCurrent)}
        />
        <NewPassword
          label="New password"
          password={password}
          confirm={confirm}
          setPassword={edit(setPassword)}
          setConfirm={edit(setConfirm)}
        />
        <ForgetWarning />
        <FormError message={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => store().closeDialog(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ResetBody() {
  const store = useSecretsStore.getState;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      await store().reset();
      toast.success("Secret store reset", {
        description: "Every stored secret value was deleted. Set the values again where you need them.",
      });
      store().closeDialog(false);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Reset the secret store?</AlertDialogTitle>
        <AlertDialogDescription>
          Every secret value stored on this machine is deleted, along with the master password. Your variables
          keep their names, so you can set the values again. This can&apos;t be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <FormError message={error} />
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="destructive" disabled={busy} onClick={() => void reset()}>
          {busy ? "Resetting…" : "Reset secret store"}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
