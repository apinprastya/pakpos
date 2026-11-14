import { useRef } from "react";
import { Code2, ListTree, MoreHorizontal, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modKeyLabel } from "@/lib/platform";
import { copyAsCurl } from "@/features/code/actions";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import type { Tab } from "@/stores/tabs";
import { useTreeStore } from "@/stores/tree";

/** Shortcut label for "Generate code" (see useShortcuts). */
function codeShortcutLabel(): string {
  return `${modKeyLabel()}+Shift+C`;
}

/** "Generate code" and the request's "More actions" menu, next to Send. */
export function RequestActions({ tab }: { tab: Tab }) {
  const openCode = () => useCodeDialogsStore.getState().openCode(tab.id);
  const noUrl = tab.request.url.trim() === "";
  const savedId = tab.saved?.id ?? "";
  // Revealing focuses the tree row; don't hand focus back to the menu button.
  const revealing = useRef(false);
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Generate code"
            onClick={openCode}
          >
            <Code2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Generate code ({codeShortcutLabel()})</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9" aria-label="More request actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More request actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-56"
          onCloseAutoFocus={(e) => {
            if (revealing.current) e.preventDefault();
            revealing.current = false;
          }}
        >
          <DropdownMenuItem disabled={noUrl} onSelect={() => void copyAsCurl(tab.request, tab.parentId)}>
            <Terminal /> Copy as cURL
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openCode}>
            <Code2 /> Generate code…
            <DropdownMenuShortcut>{codeShortcutLabel()}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!savedId}
            onSelect={() => {
              revealing.current = useTreeStore.getState().revealInTree(savedId, { show: true });
            }}
          >
            <ListTree /> Reveal in sidebar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
