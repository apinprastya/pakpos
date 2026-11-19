// Dynamic imports of the rarely opened dialogs and panes (scripts, console, runner, tools),
// shared by their React.lazy wrappers and the idle-time preloader below.
export const loadSettings = () => import("@/features/settings/SettingsDialog");
export const loadImportCurl = () => import("@/features/code/ImportCurlDialog");
export const loadCode = () => import("@/features/code/CodeDialog");
export const loadPalette = () => import("@/features/palette/CommandPalette");
export const loadUpdate = () => import("@/features/update/UpdateDialog");
export const loadCookies = () => import("@/features/cookies/CookieManagerDialog");
export const loadScripts = () => import("@/features/scripts/ScriptsSection");
export const loadConsole = () => import("@/features/console/ConsoleDrawer");
export const loadRunner = () => import("@/features/runner/RunnerView");
export const loadOtherAuth = () => import("@/features/request/OtherAuthFields");
export const loadJwtTool = () => import("@/features/tools/jwt/JwtTool");
export const loadJsonTool = () => import("@/features/tools/json/JsonTool");
export const loadUrlTool = () => import("@/features/tools/url/UrlTool");

/** The palette first: it's the one opened most and expected to be instant. */
export const dialogLoaders: ReadonlyArray<() => Promise<unknown>> = [
  loadPalette,
  loadSettings,
  loadCode,
  loadImportCurl,
  loadCookies,
  loadScripts,
  loadConsole,
  loadRunner,
  loadOtherAuth,
  loadJwtTool,
  loadJsonTool,
  loadUrlTool,
  loadUpdate,
];

type IdleWindow = Pick<Window, "setTimeout" | "clearTimeout"> & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Fetches the dialog chunks one at a time once the app is idle, so the first
 * open of a dialog doesn't wait on the network/disk. Startup isn't slowed: the
 * work only starts after first paint settles. Failures are ignored; the dialog
 * simply loads on open as before. Returns a cancel function.
 */
export function schedulePreload(
  loaders: ReadonlyArray<() => Promise<unknown>> = dialogLoaders,
  win: IdleWindow = window,
): () => void {
  let cancelled = false;
  let handle: { idle?: number; timer?: number } = {};
  const schedule = (fn: () => void) => {
    if (win.requestIdleCallback) handle = { idle: win.requestIdleCallback(fn, { timeout: 5000 }) };
    else handle = { timer: win.setTimeout(fn, 1500) };
  };
  const next = (i: number) => {
    if (cancelled || i >= loaders.length) return;
    schedule(() => {
      if (cancelled) return;
      loaders[i]()
        .catch(() => undefined)
        .then(() => next(i + 1));
    });
  };
  next(0);
  return () => {
    cancelled = true;
    if (handle.idle !== undefined) win.cancelIdleCallback?.(handle.idle);
    if (handle.timer !== undefined) win.clearTimeout(handle.timer);
  };
}
