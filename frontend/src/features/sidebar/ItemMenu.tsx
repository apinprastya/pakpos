import type { LucideIcon } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/** An item of a submenu; `depth` indents it to show nesting (e.g. folders in a collection). */
export interface SubmenuItem {
  label: string;
  onSelect: () => void;
  depth?: number;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Accessible name when the label alone is ambiguous (e.g. the full path). */
  ariaLabel?: string;
}

export type MenuEntry =
  | {
      label: string;
      icon: LucideIcon;
      onSelect: () => void;
      shortcut?: string;
      destructive?: boolean;
    }
  | { label: string; icon: LucideIcon; submenu: SubmenuItem[]; empty: string }
  | "separator";

const parts = {
  context: {
    Content: ContextMenuContent,
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Content: DropdownMenuContent,
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
};

/** Renders the same actions as a right-click menu or a "More actions" dropdown. */
export function ItemMenuContent({ kind, entries }: { kind: "context" | "dropdown"; entries: MenuEntry[] }) {
  const P = parts[kind];
  return (
    <P.Content className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
      {entries.map((entry, i) => {
        if (entry === "separator") return <P.Separator key={`sep-${i}`} />;
        const Icon = entry.icon;
        if ("submenu" in entry) {
          return (
            <P.Sub key={entry.label}>
              <P.SubTrigger>
                <Icon /> {entry.label}
              </P.SubTrigger>
              <P.SubContent className="max-h-80 w-56 overflow-y-auto">
                {entry.submenu.length === 0 && (
                  <P.Item disabled>
                    <span className="text-muted-foreground">{entry.empty}</span>
                  </P.Item>
                )}
                {entry.submenu.map((s, j) => {
                  const SubIcon = s.icon;
                  return (
                    <P.Item
                      key={`${j}-${s.label}`}
                      onSelect={s.onSelect}
                      disabled={s.disabled}
                      aria-label={s.ariaLabel}
                      style={s.depth ? { paddingLeft: `${0.5 + s.depth * 0.875}rem` } : undefined}
                    >
                      {SubIcon && <SubIcon />}
                      <span className="truncate">{s.label}</span>
                    </P.Item>
                  );
                })}
              </P.SubContent>
            </P.Sub>
          );
        }
        return (
          <P.Item
            key={entry.label}
            onSelect={entry.onSelect}
            variant={entry.destructive ? "destructive" : "default"}
          >
            <Icon /> {entry.label}
            {entry.shortcut && <P.Shortcut>{entry.shortcut}</P.Shortcut>}
          </P.Item>
        );
      })}
    </P.Content>
  );
}
