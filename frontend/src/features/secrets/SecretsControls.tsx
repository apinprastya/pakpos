import { useEffect } from "react";
import { KeyRound, Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSecretsStore } from "@/stores/secrets";
import { fileStoreState } from "./password";

/**
 * Status bar lock indicator, shown only when secrets live in the encrypted
 * file (there's nothing to unlock with the system keychain).
 */
export function LockIndicator() {
  const status = useSecretsStore((s) => s.status);
  if (!status || status.backend !== "file") return null;
  const { label, action } = fileStoreState(status);
  const onClick = () => {
    const store = useSecretsStore.getState();
    if (!status.hasPassword) store.openDialog("set-password");
    else if (status.locked) store.openDialog("unlock");
    else void store.lock();
  };
  const Icon = status.hasPassword && !status.locked ? LockOpen : Lock;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}. ${action}`}
          onClick={onClick}
          className="flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon aria-hidden className="size-3" />
          <span>{status.hasPassword && !status.locked ? "Unlocked" : "Locked"}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{action}</TooltipContent>
    </Tooltip>
  );
}

/** The "Secrets" section of the Settings dialog: which store is used, and its controls. */
export function SecretsSection() {
  const status = useSecretsStore((s) => s.status);
  const store = useSecretsStore.getState;
  useEffect(() => {
    void useSecretsStore.getState().refresh();
  }, []);

  if (!status) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking the secret store…
      </p>
    );
  }

  return (
    <section aria-labelledby="settings-secrets" className="flex flex-col gap-4">
      <div>
        <h3 id="settings-secrets" className="mb-1 text-sm font-semibold">
          Secret store
        </h3>
        <p className="text-sm">
          {status.backend === "keychain" ? "System keychain" : "Encrypted file with a master password"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {status.backend === "keychain"
            ? "Secret variable values are kept in your operating system's keychain on this machine, never in workspace files. There's no master password to manage."
            : "This machine has no usable system keychain, so secret variable values are kept in an encrypted file in Pakpos's data folder, never in workspace files."}
        </p>
        {status.backend === "file" && (
          <p className="mt-1 text-xs text-muted-foreground">The actions below apply right away.</p>
        )}
      </div>
      {status.backend === "file" && (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-sm">
            <KeyRound aria-hidden className="size-4 text-muted-foreground" />
            {fileStoreState(status).label}
          </p>
          <div className="flex flex-wrap gap-2">
            {!status.hasPassword && (
              <Button type="button" size="sm" onClick={() => store().openDialog("set-password")}>
                Set master password…
              </Button>
            )}
            {status.hasPassword && status.locked && (
              <Button type="button" size="sm" onClick={() => store().openDialog("unlock")}>
                <LockOpen /> Unlock…
              </Button>
            )}
            {status.hasPassword && !status.locked && (
              <Button type="button" size="sm" variant="outline" onClick={() => void store().lock()}>
                <Lock /> Lock now
              </Button>
            )}
            {status.hasPassword && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => store().openDialog("change-password")}
              >
                Change master password…
              </Button>
            )}
          </div>
          <div className="border-t pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Forgot the password, or the file is damaged? Resetting deletes every stored secret value; your
              variables keep their names.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => store().openDialog("reset")}>
              Reset secret store…
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
