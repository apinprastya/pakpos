import { toast } from "sonner";
import { api } from "@/lib/api";
import { compactRequest, type Request } from "@/lib/model";
import { isRequestTab, useTabsStore } from "@/stores/tabs";
import { createElement } from "react";
import { dismissOnDialog } from "@/lib/dialogToasts";
import { codeNotes } from "./summary";
import { WarningList } from "./WarningList";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The paste toast's id: a new paste replaces it, and it closes when a dialog opens. */
export const PASTE_TOAST_ID = "curl-paste";

/**
 * The name a pasted request gets: a saved request, or a draft the user named,
 * keeps its name; an unnamed draft takes the suggested one ("POST /v2/orders").
 */
export function pastedName(previous: Request, saved: boolean, suggested: string): string {
  if (saved) return previous.name;
  return previous.name === "" || previous.name === "Untitled request" ? suggested : previous.name;
}

/**
 * Replaces a tab's request with one read from a curl command (pasted into the
 * URL bar). The tab keeps its saved identity (id, order) and parent, so
 * saving overwrites the same request; see `pastedName` for the name. The
 * toast offers Undo, which restores the previous draft.
 */
export async function importCurlIntoTab(tabId: string, text: string): Promise<void> {
  let imported;
  try {
    imported = await api.importCurl(text);
  } catch (e) {
    toast.error("Couldn't import the cURL command", { description: errorMessage(e) });
    return;
  }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || !isRequestTab(tab)) return;
  const previous = tab.request;
  const { request, warnings } = imported;
  useTabsStore.getState().updateRequest(tabId, () => ({
    ...request,
    id: previous.id,
    name: pastedName(previous, tab.saved !== null, request.name),
    seq: previous.seq,
  }));
  dismissOnDialog(PASTE_TOAST_ID);
  toast.success("Imported from cURL", {
    id: PASTE_TOAST_ID,
    description: warnings.length ? createElement(WarningList, { warnings }) : undefined,
    duration: warnings.length ? 8_000 : 6_000,
    action: {
      label: "Undo",
      onClick: () => {
        if (useTabsStore.getState().tabs.some((t) => t.id === tabId)) {
          useTabsStore.getState().updateRequest(tabId, () => previous);
        }
      },
    },
  });
}

/**
 * Copies the request as a curl command, with variables resolved and secrets
 * left as `{{name}}`. The toast notes masked secrets and unresolved variables.
 */
export async function copyAsCurl(req: Request, parentId: string): Promise<void> {
  let result;
  try {
    result = await api.generateCode(compactRequest(req), parentId, "curl", {
      resolveVariables: true,
      revealSecrets: false,
    });
  } catch (e) {
    toast.error("Couldn't copy as cURL", { description: errorMessage(e) });
    return;
  }
  try {
    await navigator.clipboard.writeText(result.code);
  } catch {
    toast.error("Couldn't copy as cURL", { description: "The clipboard isn't available." });
    return;
  }
  const notes = codeNotes(result);
  toast.success("Copied as cURL", { description: notes.length ? notes.join(" ") : undefined });
}

/** Copy as cURL for a saved request in the tree (its saved version, inheriting from its parent on disk). */
export async function copySavedAsCurl(id: string, parentId: string): Promise<void> {
  let req: Request;
  try {
    req = await api.getRequest(id);
  } catch (e) {
    toast.error("Couldn't copy as cURL", { description: errorMessage(e) });
    return;
  }
  await copyAsCurl(req, parentId);
}
