import { Code2, MoreHorizontal, Terminal } from "lucide-react";
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

/** Shortcut label for "Generate code" (see useShortcuts). */
function codeShortcutLabel(): string {
  return `${modKeyLabel()}+Shift+C`;
}

/** "Generate code" and the request's "More actions" menu, next to Send. */
export function RequestActions({ tab }: { tab: Tab }) {
  const openCode = () => useCodeDialogsStore.getState().openCode(tab.id);
  const noUrl = tab.request.url.trim() === "";
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
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          <DropdownMenuItem disabled={noUrl} onSelect={() => void copyAsCurl(tab.request, tab.parentId)}>
            <Terminal /> Copy as cURL
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openCode}>
            <Code2 /> Generate code…
            <DropdownMenuShortcut>{codeShortcutLabel()}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
