import { useState } from "react";
import { MoveToSecretDialog } from "@/features/scopes/MoveToSecretDialog";
import type { Request } from "@/lib/model";
import { collectionIdOf } from "@/lib/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { AuthEditor } from "./AuthEditor";
import { SUGGESTED_NAMES, type SecretField } from "./auth";
import { InheritedAuth } from "./Inherited";
import type { PreviewState } from "./usePreview";

interface Props {
  request: Request;
  /** Collection or folder the request (or draft) belongs to ("" for none). */
  parentId: string;
  preview: PreviewState;
  onChange: (update: (req: Request) => Request) => void;
}

/** The request's auth, with what `inherit` resolves to and "Move to secret variable". */
export function AuthSection({ request, parentId, preview, onChange }: Props) {
  const hasWorkspace = useWorkspaceStore((s) => s.workspace !== null);
  const collections = useWorkspaceStore((s) => s.collections);
  const [moving, setMoving] = useState<{ field: SecretField; value: string } | null>(null);

  return (
    <>
      <AuthEditor
        auth={request.auth}
        onChange={(update) => onChange((r) => ({ ...r, auth: update(r.auth) }))}
        allowInherit
        inheritInfo={<InheritedAuth state={preview} hasParent={parentId !== ""} subject="request" />}
        onMoveToSecret={hasWorkspace ? (field, value) => setMoving({ field, value }) : undefined}
      />
      <MoveToSecretDialog
        value={moving?.value ?? null}
        suggestedName={moving ? SUGGESTED_NAMES[moving.field] : ""}
        collectionId={collectionIdOf(collections, parentId)}
        onMoved={(name) => {
          const field = moving!.field;
          onChange((r) => ({ ...r, auth: { ...r.auth, [field]: `{{${name}}}` } }));
        }}
        onClose={() => setMoving(null)}
      />
    </>
  );
}
