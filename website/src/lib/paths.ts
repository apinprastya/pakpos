import { LATEST_URL, RELEASES_URL } from "../scripts/site.js";

/** A path inside the site ("download/" → "/download/"); follows Astro's `base` if one is ever set. */
export function url(path = ""): string {
  return import.meta.env.BASE_URL.replace(/\/?$/, "/") + path.replace(/^\//, "");
}

export const REPO_URL = RELEASES_URL.replace(/\/releases$/, "");
export const LATEST_RELEASE_URL = LATEST_URL;
