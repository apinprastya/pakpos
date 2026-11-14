import { create } from "zustand";

const LANGUAGE_KEY = "pakpos-code-language";

function readLanguage(): string {
  try {
    return localStorage.getItem(LANGUAGE_KEY) || "curl";
  } catch {
    return "curl";
  }
}

interface CodeDialogsState {
  /** Import cURL dialog: open, and the collection or folder the new draft belongs to ("" for none). */
  importOpen: boolean;
  importParentId: string;
  /** Tab whose request the Generate code dialog shows, or null when closed. */
  codeTabId: string | null;
  /** Last language picked in the code dialog (a UI preference kept in localStorage). */
  language: string;

  openImport: (parentId?: string) => void;
  closeImport: () => void;
  openCode: (tabId: string) => void;
  closeCode: () => void;
  setLanguage: (id: string) => void;
}

export const useCodeDialogsStore = create<CodeDialogsState>()((set) => ({
  importOpen: false,
  importParentId: "",
  codeTabId: null,
  language: readLanguage(),

  openImport: (parentId = "") => set({ importOpen: true, importParentId: parentId }),
  closeImport: () => set({ importOpen: false }),
  openCode: (tabId) => set({ codeTabId: tabId }),
  closeCode: () => set({ codeTabId: null }),
  setLanguage: (id) => {
    try {
      localStorage.setItem(LANGUAGE_KEY, id);
    } catch {
      /* ignore */
    }
    set({ language: id });
  },
}));
