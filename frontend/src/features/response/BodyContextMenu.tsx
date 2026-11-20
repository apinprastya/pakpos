import { useState, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { Binary, Braces, Copy, FileJson, Route, TextSelect, Type } from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTabsStore } from "@/stores/tabs";
import { looksLikeBase64 } from "@/features/tools/base64/base64";
import { formatPath, jsonFieldAt, type JsonField } from "./jsonField";

interface Props {
  view: RefObject<EditorView | null>;
  /** Offer the JSON field items (the body is JSON). */
  json: boolean;
  children: React.ReactNode;
}

/**
 * The response body's right-click menu: copy the selection, select all and,
 * for JSON, copy the value, key or path of the field under the pointer (or at
 * the cursor when the menu is opened from the keyboard). "Open in JSON tool"
 * takes the selection, or the whole body when nothing is selected; "Decode
 * Base64" appears for a selection that looks like Base64.
 */
export function BodyContextMenu({ view, json, children }: Props) {
  const [field, setField] = useState<JsonField | null>(null);
  const [selection, setSelection] = useState("");

  const onContextMenu = (e: React.MouseEvent) => {
    const v = view.current;
    if (!v) return;
    const { from, to, head } = v.state.selection.main;
    setSelection(v.state.sliceDoc(from, to));
    if (!json) return setField(null);
    // A keyboard-opened menu has no pointer position: use the cursor.
    const keyboard = e.clientX === 0 && e.clientY === 0;
    const pos = (keyboard ? null : v.posAtCoords({ x: e.clientX, y: e.clientY })) ?? head;
    setField(jsonFieldAt(v.state.doc.toString(), pos));
  };

  const selectAll = () => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    v.focus();
  };

  const path = field ? formatPath(field.path) : "";

  const openInJsonTool = () => {
    const text = selection || view.current?.state.doc.toString() || "";
    useTabsStore.getState().openTool("json", text);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        <div className="h-full">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {field && (
          <>
            {path && (
              <ContextMenuLabel className="max-w-72 truncate font-mono font-normal" title={path}>
                {path}
              </ContextMenuLabel>
            )}
            <ContextMenuItem onSelect={() => void copy(field.value, "Value copied")}>
              <Braces />
              Copy value
            </ContextMenuItem>
            {field.key !== undefined && (
              <ContextMenuItem onSelect={() => void copy(field.key!, "Key copied")}>
                <Type />
                Copy key
              </ContextMenuItem>
            )}
            {path && (
              <ContextMenuItem onSelect={() => void copy(path, "Path copied")}>
                <Route />
                Copy path
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!selection} onSelect={() => void copy(selection, "Selection copied")}>
          <Copy />
          Copy selection
        </ContextMenuItem>
        <ContextMenuItem onSelect={selectAll}>
          <TextSelect />
          Select all
        </ContextMenuItem>
        {(json || selection) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={openInJsonTool}>
              <FileJson />
              Open in JSON tool
            </ContextMenuItem>
          </>
        )}
        {selection && looksLikeBase64(selection) && (
          <ContextMenuItem onSelect={() => void useTabsStore.getState().openTool("base64", selection.trim())}>
            <Binary />
            Decode Base64
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy", { description: "The clipboard isn't available." });
  }
}
