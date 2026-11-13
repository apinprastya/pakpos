import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface DeleteTarget {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/** Confirmation for destructive sidebar actions. */
export function ConfirmDeleteDialog({
  target,
  onClose,
}: {
  target: DeleteTarget | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      {target && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target.title}</AlertDialogTitle>
            <AlertDialogDescription>{target.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                target.onConfirm();
                onClose();
              }}
            >
              {target.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
