// @ts-check
import { defineConfig } from "astro/config";

// Served from the root of its domain (/, /download/). Set SITE_URL (e.g.
// https://pakpos.dev) when building so canonical and og:image URLs are absolute;
// without it they're left out.
export default defineConfig({
  output: "static",
  site: process.env.SITE_URL || undefined,
});
