import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { usePaletteStore } from "@/stores/palette";
import { useSettingsStore } from "@/stores/settings";
import { useUpdateStore } from "@/stores/update";
import {
  loadCode,
  loadImportCurl,
  loadPalette,
  loadSettings,
  loadUpdate,
  schedulePreload,
} from "./dialogChunks";

// Rarely opened dialogs are separate chunks, loaded the first time they open,
// so they (and cmdk, the settings form, the code generator UI) stay out of the
// startup bundle.
const SettingsDialog = lazy(() => loadSettings().then((m) => ({ default: m.SettingsDialog })));
const ImportCurlDialog = lazy(() => loadImportCurl().then((m) => ({ default: m.ImportCurlDialog })));
const CodeDialog = lazy(() => loadCode().then((m) => ({ default: m.CodeDialog })));
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
const UpdateDialog = lazy(() => loadUpdate().then((m) => ({ default: m.UpdateDialog })));

/**
 * Mounts `children` from the first time `open` is true and keeps them mounted
 * afterwards, so later opens are instant and closing animates as usual.
 */
export function MountWhenOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened ? <Suspense fallback={null}>{children}</Suspense> : null;
}

export function LazyDialogs() {
  const settings = useSettingsStore((s) => s.dialogOpen);
  const importCurl = useCodeDialogsStore((s) => s.importOpen);
  const code = useCodeDialogsStore((s) => !!s.codeTabId);
  const palette = usePaletteStore((s) => s.open);
  const update = useUpdateStore((s) => s.dialogOpen);
  // Not under Vitest: tests mount the shell many times and open dialogs explicitly.
  useEffect(() => (import.meta.env.MODE === "test" ? undefined : schedulePreload()), []);
  return (
    <>
      <MountWhenOpened open={settings}>
        <SettingsDialog />
      </MountWhenOpened>
      <MountWhenOpened open={importCurl}>
        <ImportCurlDialog />
      </MountWhenOpened>
      <MountWhenOpened open={code}>
        <CodeDialog />
      </MountWhenOpened>
      <MountWhenOpened open={palette}>
        <CommandPalette />
      </MountWhenOpened>
      <MountWhenOpened open={update}>
        <UpdateDialog />
      </MountWhenOpened>
    </>
  );
}
