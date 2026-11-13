import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveTabAs } from "@/features/request/actions";
import { api } from "@/lib/api";
import type { CollectionNode, WorkspaceInfo } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";

const NEW_COLLECTION = "__new__";

type Load =
  | { state: "loading" }
  | { state: "no-workspace" }
  | { state: "ready"; workspace: WorkspaceInfo; collections: CollectionNode[] };

async function fetchWorkspace(): Promise<Load> {
  try {
    const workspace = await api.currentWorkspace();
    if (!workspace) return { state: "no-workspace" };
    return { state: "ready", workspace, collections: await api.collections() };
  } catch (e) {
    toast.error("Couldn't load the workspace", { description: String(e) });
    return { state: "no-workspace" };
  }
}

/** Save dialog for requests that have never been saved. */
export function SaveRequestDialog() {
  const dialog = useTabsStore((s) => s.saveDialog);
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.saveDialog?.tabId));
  const open = !!dialog && !!tab;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && useTabsStore.getState().closeSaveDialog()}>
      {open && (
        <SaveForm key={tab.id} tabId={tab.id} initialName={tab.request.name} closeAfter={dialog.closeAfter} />
      )}
    </Dialog>
  );
}

function SaveForm({
  tabId,
  initialName,
  closeAfter,
}: {
  tabId: string;
  initialName: string;
  closeAfter: boolean;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [name, setName] = useState(initialName || "Untitled request");
  const [collection, setCollection] = useState("");
  const [newCollection, setNewCollection] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (l: Load) => {
    setLoad(l);
    if (l.state === "ready") setCollection(l.collections[0]?.id ?? NEW_COLLECTION);
  };
  const refresh = async () => apply(await fetchWorkspace());

  useEffect(() => {
    let alive = true;
    void fetchWorkspace().then((l) => alive && apply(l));
    return () => {
      alive = false;
    };
  }, []);

  const chooseFolder = async () => {
    try {
      const path = await api.pickFolder();
      if (!path) return;
      try {
        await api.openWorkspace(path);
      } catch {
        // Not a workspace yet: create one in that folder.
        await api.createWorkspace(path, "");
      }
      await refresh();
    } catch (e) {
      toast.error("Couldn't open the folder", { description: String(e) });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (load.state !== "ready" || !name.trim()) return;
    setBusy(true);
    try {
      let collectionId = collection;
      if (collection === NEW_COLLECTION) {
        if (!newCollection.trim()) return;
        collectionId = (await api.createCollection(newCollection.trim())).id;
      }
      const ok = await saveTabAs(tabId, collectionId, name.trim());
      if (ok) {
        const store = useTabsStore.getState();
        store.closeSaveDialog();
        if (closeAfter) store.close(tabId);
      }
    } catch (err) {
      toast.error("Couldn't create the collection", { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Save request</DialogTitle>
        <DialogDescription>
          {load.state === "ready"
            ? `Saved as a file in ${load.workspace.name}.`
            : "Requests are saved as files in a workspace folder."}
        </DialogDescription>
      </DialogHeader>

      {load.state === "loading" && <p className="text-sm text-muted-foreground">Loading workspace…</p>}

      {load.state === "no-workspace" && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm">
            No workspace is open. Choose a folder to keep your requests in. If it isn&apos;t a workspace yet,
            one is created there.
          </p>
          <Button onClick={chooseFolder}>
            <FolderOpen /> Choose folder
          </Button>
        </div>
      )}

      {load.state === "ready" && (
        <form id="save-request-form" onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="save-name">Name</Label>
            <Input id="save-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="save-collection">Collection</Label>
            <Select value={collection} onValueChange={setCollection}>
              <SelectTrigger id="save-collection" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {load.collections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_COLLECTION}>New collection…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {collection === NEW_COLLECTION && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="save-new-collection">New collection name</Label>
              <Input
                id="save-new-collection"
                value={newCollection}
                placeholder="My API"
                onChange={(e) => setNewCollection(e.target.value)}
              />
            </div>
          )}
        </form>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={() => useTabsStore.getState().closeSaveDialog()}>
          Cancel
        </Button>
        {load.state === "ready" && (
          <Button
            type="submit"
            form="save-request-form"
            disabled={busy || !name.trim() || (collection === NEW_COLLECTION && !newCollection.trim())}
          >
            Save request
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
