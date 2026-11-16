/** True when running on macOS (used for shortcut labels). */
export function isMac(platform: string = navigator.platform): boolean {
  return /mac/i.test(platform);
}

/**
 * Marks the platform on <html> (`data-platform="mac"`), so CSS can leave room
 * for the macOS window buttons and turn the header into a drag area.
 */
export function markPlatform(root: HTMLElement = document.documentElement, platform?: string): void {
  root.dataset.platform = isMac(platform) ? "mac" : "other";
}

/** Label for the primary modifier key on the current platform. */
export function modKeyLabel(platform?: string): string {
  return isMac(platform) ? "⌘" : "Ctrl";
}
