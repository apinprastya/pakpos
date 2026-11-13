/** True when running on macOS (used for shortcut labels). */
export function isMac(platform: string = navigator.platform): boolean {
  return /mac/i.test(platform);
}

/** Label for the primary modifier key on the current platform. */
export function modKeyLabel(platform?: string): string {
  return isMac(platform) ? "⌘" : "Ctrl";
}
