import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { saveTab } from "@/features/request/actions";
import { tabTitle, useTabsStore } from "@/stores/tabs";

/** Asks what to do with unsaved changes before a tab closes. */
export function CloseTabDialog() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.pendingCloseId));
  const { cancelClose, close } = useTabsStore.getState();

  return (
    <AlertDialog open={!!tab} onOpenChange={(open) => !open && cancelClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {tab ? tabTitle(tab) : "this request"}?</AlertDialogTitle>
          <AlertDialogDescription>Your changes are lost if you close without saving.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={cancelClose}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => tab && close(tab.id)}>
            Don&apos;t save
          </Button>
          <Button
            onClick={() => {
              if (!tab) return;
              cancelClose();
              void saveTab(tab.id, true);
            }}
          >
            Save
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
