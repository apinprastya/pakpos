import { toast } from "sonner";
import { api } from "@/lib/api";
import { describeImport, type ImportOptions, type ImportResult, type ImportSummary } from "@/lib/importModel";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Imports a Postman export that was previewed as `preview`, then shows what
 * it added: a collection is revealed in the sidebar, an environment or the
 * globals open in a tab. Resolves with the result, or null when the user
 * didn't unlock the secret store the import needs. Rejects with Go's
 * message when the import fails (nothing is left half-imported).
 */
export async function importPostmanFile(
  path: string,
  opts: ImportOptions,
  preview: ImportSummary,
): Promise<ImportResult | null> {
  if (preview.secretValues && !(await useSecretsStore.getState().ensureReady())) return null;
  const res = await api.importPostman(path, opts);
  toast.success(`Imported "${res.name}"`, { description: describeImport(res) });
  if (res.kind === "collection") {
    await useWorkspaceStore.getState().refresh();
    useTreeStore.getState().revealInTree(res.id, { show: true });
    return res;
  }
  const envs = useEnvironmentsStore.getState();
  await envs.load();
  envs.touch();
  if (res.kind === "environment") envs.open(res.id);
  else envs.openGlobals();
  return res;
}
