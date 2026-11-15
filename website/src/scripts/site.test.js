import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LATEST_API,
  applyOS,
  applyRelease,
  detectOS,
  fetchLatest,
  findAsset,
  formatSize,
  init,
  versionOf,
} from "./site.js";

// A tiny stand-in for the DOM: just the parts site.js touches.
class El {
  constructor(attrs = {}, children = []) {
    this.attrs = { ...attrs };
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("data-")) {
        this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
      }
    }
    this.children = children;
    this.textContent = "";
    this.classes = new Set();
    this.classList = { add: (c) => this.classes.add(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  matches(selector) {
    return selector
      .split(",")
      .map((s) => s.trim().replace(/^\[|\]$/g, ""))
      .some((attr) => attr in this.attrs);
  }
  querySelectorAll(selector) {
    return this.all().filter((el) => el.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const release = {
  tag_name: "v26.11.2",
  html_url: "https://github.com/apinprastya/pakpos/releases/tag/v26.11.2",
  assets: [
    {
      name: "pakpos-26.11.2-windows-amd64-setup.exe",
      browser_download_url: "https://example.test/setup.exe",
      size: 12 * 1024 * 1024,
    },
    {
      name: "SHA256SUMS",
      browser_download_url: "https://example.test/SHA256SUMS",
      size: 600,
    },
  ],
};

function downloadPage() {
  const size = new El({ "data-size": "" });
  const setup = new El({ href: "fallback", "data-asset": "-windows-amd64-setup.exe" }, [size]);
  const dmg = new El({ href: "fallback", "data-asset": "-macos-universal.dmg" });
  const version = new El({ "data-version": "" });
  const sums = new El({ href: "fallback", "data-sums": "" });
  const win = new El({ "data-platform": "windows" });
  const mac = new El({ "data-platform": "macos" });
  const button = new El({ "data-os-name": "" });
  const doc = new El({}, [win, mac, setup, dmg, version, sums, button]);
  return { doc, size, setup, dmg, version, sums, win, mac, button };
}

const ok = (body) => async () => ({ ok: true, json: async () => body });

test("detectOS", () => {
  const cases = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "", "linux"],
    ["Mozilla/5.0 (X11; CrOS x86_64)", "", "linux"],
    ["Mozilla/5.0", "MacIntel", "macos"],
    ["Mozilla/5.0 (Linux; Android 14)", "", null],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "", null],
    ["", "", null],
    [undefined, undefined, null],
  ];
  for (const [ua, platform, want] of cases) {
    assert.equal(detectOS(ua, platform), want, `${ua} / ${platform}`);
  }
});

test("versionOf", () => {
  assert.equal(versionOf("v26.11.1"), "26.11.1");
  assert.equal(versionOf("26.11.1"), "26.11.1");
  assert.equal(versionOf(undefined), "");
});

test("formatSize", () => {
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(undefined), "");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(41.2 * 1024 * 1024), "41.2 MB");
  assert.equal(formatSize(3 * 1024 ** 4), "3072.0 GB");
});

test("findAsset", () => {
  assert.deepEqual(findAsset(release, "-windows-amd64-setup.exe"), {
    name: "pakpos-26.11.2-windows-amd64-setup.exe",
    url: "https://example.test/setup.exe",
    size: 12 * 1024 * 1024,
  });
  assert.equal(findAsset(release, "-macos-universal.dmg"), null);
  assert.equal(findAsset(null, "-macos-universal.dmg"), null);
});

test("fetchLatest returns the release", async () => {
  let asked;
  const got = await fetchLatest(async (url) => {
    asked = url;
    return { ok: true, json: async () => release };
  });
  assert.equal(asked, LATEST_API);
  assert.equal(got, release);
});

test("fetchLatest returns null on any failure", async () => {
  assert.equal(await fetchLatest(async () => ({ ok: false })), null);
  assert.equal(await fetchLatest(ok({})), null);
  assert.equal(await fetchLatest(ok(null)), null);
  assert.equal(
    await fetchLatest(async () => {
      throw new Error("offline");
    }),
    null,
  );
});

test("applyOS highlights the visitor's platform", () => {
  const p = downloadPage();
  applyOS(p.doc, "windows");
  assert.equal(p.button.textContent, "Download for Windows");
  assert.ok(p.win.classes.has("is-current"));
  assert.ok(!p.mac.classes.has("is-current"));
});

test("applyOS without an OS leaves the page alone", () => {
  const p = downloadPage();
  applyOS(p.doc, null);
  assert.equal(p.button.textContent, "");
  assert.equal(p.win.classes.size, 0);
});

test("applyRelease points links at the release files", () => {
  const p = downloadPage();
  applyRelease(p.doc, release);
  assert.equal(p.setup.getAttribute("href"), "https://example.test/setup.exe");
  assert.equal(p.size.textContent, "12.0 MB");
  assert.equal(p.dmg.getAttribute("href"), "fallback", "missing file keeps its fallback");
  assert.equal(p.version.textContent, "Version 26.11.2");
  assert.equal(p.version.getAttribute("href"), release.html_url);
  assert.equal(p.sums.getAttribute("href"), "https://example.test/SHA256SUMS");
});

test("applyRelease copes with a sparse release", () => {
  const p = downloadPage();
  applyRelease(p.doc, null);
  assert.equal(p.version.textContent, "");
  applyRelease(p.doc, { tag_name: "v1.0.0" });
  assert.equal(p.version.textContent, "Version 1.0.0");
  assert.equal(p.version.getAttribute("href"), undefined);
  assert.equal(p.sums.getAttribute("href"), "fallback");
});

test("init wires the download page", async () => {
  const p = downloadPage();
  const got = await init(p.doc, { userAgent: "Mozilla/5.0 (Windows NT 10.0)" }, ok(release));
  assert.equal(got, release);
  assert.equal(p.button.textContent, "Download for Windows");
  assert.equal(p.setup.getAttribute("href"), "https://example.test/setup.exe");
});

test("init skips the network on pages without downloads", async () => {
  const button = new El({ "data-os-name": "" });
  const doc = new El({}, [button]);
  let called = false;
  const got = await init(doc, { userAgent: "X11; Linux" }, async () => {
    called = true;
  });
  assert.equal(got, null);
  assert.equal(called, false);
  assert.equal(button.textContent, "Download for Linux");
});

test("init without navigator info", async () => {
  const p = downloadPage();
  assert.equal(await init(p.doc, undefined, async () => ({ ok: false })), null);
  assert.equal(p.button.textContent, "");
});
