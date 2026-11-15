// Pakpos website: finds the latest GitHub release and points the download
// links at its files. Without JavaScript, or if GitHub can't be reached, every
// link keeps its static fallback (the latest release page), so nothing breaks.
// The layout (src/layouts/Base.astro) calls init(document, navigator).

export const REPO = "apinprastya/pakpos";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_URL = `${RELEASES_URL}/latest`;
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Human names for the operating systems we build for. */
export const OS_NAMES = { windows: "Windows", macos: "macOS", linux: "Linux" };

/**
 * The OS of the visitor, from the user agent (and navigator.platform when the
 * user agent is reduced). Returns null for phones, tablets and unknowns.
 */
export function detectOS(userAgent = "", platform = "") {
  const ua = `${userAgent} ${platform}`.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(ua)) return null;
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux") || ua.includes("x11") || ua.includes("cros")) return "linux";
  return null;
}

/** "v26.11.1" → "26.11.1". */
export function versionOf(tag) {
  return String(tag ?? "").replace(/^v/, "");
}

/** Bytes as a short size, e.g. 41.2 MB. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/**
 * Finds the release asset whose name is pakpos-<version><suffix>
 * (the names release.yml gives them). Returns null when it's missing.
 */
export function findAsset(release, suffix) {
  const name = `pakpos-${versionOf(release?.tag_name)}${suffix}`;
  const asset = (release?.assets ?? []).find((a) => a.name === name);
  return asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null;
}

/** Fetches the latest stable release, or null if that fails for any reason. */
export async function fetchLatest(fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const release = await res.json();
    return release && release.tag_name ? release : null;
  } catch {
    return null;
  }
}

/** Marks the visitor's OS and names it on the "Download for …" buttons. */
export function applyOS(doc, os) {
  if (!os) return;
  for (const el of doc.querySelectorAll("[data-os-name]")) {
    el.textContent = `Download for ${OS_NAMES[os]}`;
  }
  for (const el of doc.querySelectorAll("[data-platform]")) {
    if (el.dataset.platform === os) el.classList.add("is-current");
  }
}

/**
 * Points every [data-asset] link at the file in the release, fills in its
 * size, and shows the version. Links whose file is missing keep their fallback.
 */
export function applyRelease(doc, release) {
  if (!release) return;
  const version = versionOf(release.tag_name);
  for (const el of doc.querySelectorAll("[data-version]")) {
    el.textContent = `Version ${version}`;
    if (release.html_url) el.setAttribute("href", release.html_url);
  }
  for (const link of doc.querySelectorAll("[data-asset]")) {
    const asset = findAsset(release, link.dataset.asset);
    if (!asset) continue;
    link.setAttribute("href", asset.url);
    const size = link.querySelector("[data-size]");
    if (size) size.textContent = formatSize(asset.size);
  }
  const sums = (release.assets ?? []).find((a) => a.name === "SHA256SUMS");
  for (const el of doc.querySelectorAll("[data-sums]")) {
    if (sums) el.setAttribute("href", sums.browser_download_url);
  }
}

/** Wires up a page. Returns the release it found (null if none). */
export async function init(doc, nav, fetchFn) {
  applyOS(doc, detectOS(nav?.userAgent, nav?.platform));
  if (!doc.querySelector("[data-asset], [data-version]")) return null;
  const release = await fetchLatest(fetchFn);
  applyRelease(doc, release);
  return release;
}
