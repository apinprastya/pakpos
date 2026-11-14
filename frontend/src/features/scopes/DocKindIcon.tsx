import { Folder, FolderTree, Globe, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocKind } from "@/stores/tabs";

/** The icon of an environment, globals, collection or folder settings tab. */
export function DocKindIcon({ kind, className }: { kind: DocKind; className?: string }) {
  const props = { "aria-hidden": true, className: cn("shrink-0 text-muted-foreground", className) };
  switch (kind) {
    case "environment":
      return <Layers {...props} />;
    case "globals":
      return <Globe {...props} />;
    case "collection":
      return <FolderTree {...props} />;
    case "folder":
      return <Folder {...props} />;
  }
}
