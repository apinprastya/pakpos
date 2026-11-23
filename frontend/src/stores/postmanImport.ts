import { create } from "zustand";

interface PostmanImportState {
  /** The "Import from Postman" dialog is open. */
  open: boolean;
  /** Keep variables that look like credentials in the secret store (kept while the app runs). */
  guessSecrets: boolean;

  openDialog: () => void;
  close: () => void;
  setGuessSecrets: (on: boolean) => void;
}

export const postmanImportInitial = { open: false, guessSecrets: true };

export const usePostmanImportStore = create<PostmanImportState>()((set) => ({
  ...postmanImportInitial,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
  setGuessSecrets: (on) => set({ guessSecrets: on }),
}));
