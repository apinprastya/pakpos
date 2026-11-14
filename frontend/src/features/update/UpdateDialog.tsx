import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateStore } from "@/stores/update";
import { megabytes, percent, releaseDate } from "./format";

/**
 * Software update: the result of a check, the download of a verified release
 * and the restart into it. Closing it doesn't stop a download.
 */
export function UpdateDialog() {
  const open = useUpdateStore((s) => s.dialogOpen);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && useUpdateStore.getState().closeDialog()}>
      {open && <UpdateBody />}
    </Dialog>
  );
}

function UpdateBody() {
  const phase = useUpdateStore((s) => s.phase);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const { closeDialog, check, install, cancel, restart, openReleasePage, skip } = useUpdateStore.getState();

  const available = phase !== "checking" && !!info?.available;
  const date = info ? releaseDate(info.publishedAt) : "";
  const pct = progress ? percent(progress.done, progress.total) : null;

  return (
    <DialogContent className="sm:max-w-lg" aria-busy={phase === "checking" || phase === "installing"}>
      <DialogHeader>
        <DialogTitle>Software update</DialogTitle>
        <DialogDescription>
          {phase === "checking" && "Checking for updates…"}
          {phase === "idle" && !error && "Pakpos hasn't checked for updates yet."}
          {phase === "idle" && error && "Pakpos couldn't check for updates."}
          {phase === "checked" &&
            info &&
            !info.available &&
            `You're up to date. Pakpos ${info.current} is the latest version.`}
          {available && phase !== "installed" && info && (
            <>
              Pakpos {info.latest} is available. You have {info.current}.{date && ` Released ${date}.`}
            </>
          )}
          {phase === "installed" &&
            info &&
            `Pakpos ${info.latest} is installed. Restart to start using it; open tabs and unsaved edits are kept.`}
        </DialogDescription>
      </DialogHeader>

      {available && phase !== "installed" && info?.notes.trim() && (
        <pre
          aria-label="Release notes"
          tabIndex={0}
          className="selectable max-h-60 overflow-y-auto rounded-md border bg-card px-3 py-2 font-sans text-xs whitespace-pre-wrap text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {info.notes.trim()}
        </pre>
      )}

      {available && phase === "checked" && !info?.canInstall && info?.reason && (
        <p role="note" className="text-xs text-muted-foreground">
          {info.reason}
        </p>
      )}

      {phase === "installing" && (
        <div className="flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${pct ?? 0}%` }} />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {progress
              ? `${megabytes(progress.done)}${progress.total > 0 ? ` of ${megabytes(progress.total)}` : ""}`
              : "Starting download…"}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="flex gap-2 text-xs text-destructive">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}

      <DialogFooter className="sm:justify-between">
        <div className="flex gap-2">
          {available && phase === "checked" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => void openReleasePage()}>
                Open release page
              </Button>
              <Button variant="ghost" size="sm" onClick={skip}>
                Skip this version
              </Button>
            </>
          )}
        </div>
        <div className="flex gap-2">
          {phase === "installing" ? (
            <Button variant="outline" size="sm" onClick={() => void cancel()}>
              Cancel download
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={closeDialog}>
              {phase === "installed" || available ? "Later" : "Done"}
            </Button>
          )}
          {phase === "idle" && (
            <Button size="sm" onClick={() => void check()}>
              {error ? "Try again" : "Check for updates"}
            </Button>
          )}
          {phase === "checked" && info?.canInstall && (
            <Button size="sm" onClick={() => void install()}>
              Download and install
            </Button>
          )}
          {phase === "installed" && (
            <Button size="sm" onClick={() => void restart()}>
              Restart now
            </Button>
          )}
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
