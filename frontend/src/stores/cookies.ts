import { create } from "zustand";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { cookieRef, type CookieRef, type StoredCookie } from "@/lib/model";

/**
 * The cookie manager: the open workspace's cookie jar (kept by Go: persistent
 * cookies in SQLite, session cookies in memory) and the dialog that edits it.
 * Actions reject with Go's message so the dialog can show it.
 */
interface CookiesState {
  open: boolean;
  /** Domain shown first when opened from a response ("" for none). */
  focusDomain: string;
  cookies: StoredCookie[];
  loading: boolean;
  /** Why the list couldn't be loaded, or null. */
  error: string | null;

  openManager: (domain?: string) => void;
  close: () => void;
  load: () => Promise<void>;
  add: (c: StoredCookie) => Promise<StoredCookie>;
  update: (old: CookieRef, c: StoredCookie) => Promise<StoredCookie>;
  remove: (c: StoredCookie) => Promise<void>;
  clearDomain: (domain: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const cookiesInitial = {
  open: false,
  focusDomain: "",
  cookies: [] as StoredCookie[],
  loading: false,
  error: null as string | null,
};

export const useCookiesStore = create<CookiesState>()((set, get) => ({
  ...cookiesInitial,

  openManager: (domain = "") => {
    set({ open: true, focusDomain: domain });
    void get().load();
  },
  close: () => set({ open: false }),

  load: async () => {
    set({ loading: true });
    try {
      set({ cookies: await api.listCookies(), error: null });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ loading: false });
    }
  },

  add: async (c) => {
    const saved = await rethrow(api.addCookie(c));
    await get().load();
    return saved;
  },
  update: async (old, c) => {
    const saved = await rethrow(api.updateCookie(old, c));
    await get().load();
    return saved;
  },
  remove: async (c) => {
    await rethrow(api.deleteCookie(cookieRef(c)));
    set((s) => ({ cookies: s.cookies.filter((x) => !sameCookie(x, c)) }));
  },
  clearDomain: async (domain) => {
    await rethrow(api.clearCookieDomain(domain));
    set((s) => ({ cookies: s.cookies.filter((x) => x.domain !== domain) }));
  },
  clearAll: async () => {
    await rethrow(api.clearAllCookies());
    set({ cookies: [] });
  },
}));

export function sameCookie(a: CookieRef, b: CookieRef): boolean {
  return a.domain === b.domain && a.path === b.path && a.name === b.name;
}

async function rethrow<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new Error(errorMessage(e), { cause: e });
  }
}

/** Cookies grouped by domain, domains in order (the focused one first). */
export function groupByDomain(
  cookies: StoredCookie[],
  focus = "",
): { domain: string; cookies: StoredCookie[] }[] {
  const groups = new Map<string, StoredCookie[]>();
  for (const c of cookies) {
    const list = groups.get(c.domain) ?? [];
    list.push(c);
    groups.set(c.domain, list);
  }
  return [...groups.entries()]
    .map(([domain, list]) => ({ domain, cookies: list }))
    .sort((a, b) => {
      if (a.domain === focus) return -1;
      if (b.domain === focus) return 1;
      return a.domain.localeCompare(b.domain);
    });
}

/** Keeps cookies whose domain, name or value contains `query` (case-insensitive). */
export function filterCookies(cookies: StoredCookie[], query: string): StoredCookie[] {
  const q = query.trim().toLowerCase();
  if (!q) return cookies;
  return cookies.filter(
    (c) =>
      c.domain.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.value.toLowerCase().includes(q),
  );
}
