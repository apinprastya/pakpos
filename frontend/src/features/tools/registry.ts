import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { Braces, KeyRound, Link, type LucideIcon } from "lucide-react";
import { loadJsonTool, loadJwtTool, loadUrlTool } from "@/features/shell/dialogChunks";
import {
  restoreUrlState,
  serializeUrlState,
  urlInitialState,
  urlWithInput,
  type UrlToolState,
} from "./url/state";
import {
  jsonInitialState,
  jsonWithInput,
  restoreJsonState,
  serializeJsonState,
  type JsonToolState,
} from "./json/state";
import { jwtInitialState, restoreJwtState, type JwtState } from "./jwt/state";

/** What a tool's component gets: its tab, its state, and a way to change the state. */
export interface ToolProps<S = unknown> {
  tabId: string;
  state: S;
  update: (fn: (state: S) => S) => void;
}

/**
 * A tool: one definition here plus its own folder under `features/tools/<id>/`.
 * The sidebar, palette actions, tab title and tab icon all come from it.
 */
export interface ToolDef<S = unknown> {
  id: string;
  /** Tab title and sidebar name, e.g. "JWT decoder". */
  label: string;
  /** One line for the sidebar. */
  description: string;
  icon: LucideIcon;
  /** Extra words the palette matches. */
  keywords: string[];
  /**
   * Keep the tool's state in localStorage with the open tabs. Off for tools
   * whose input is often a credential or a key: their tab reopens empty.
   */
  persist: boolean;
  /** Loaded when its tab first shows (and preloaded when the app is idle). */
  component: LazyExoticComponent<ComponentType<ToolProps<S>>>;
  /** State of a new tab, with `input` when an entry point passes one. */
  initialState: (input?: string) => S;
  /** The state with its input replaced (an entry point opening the existing tab). */
  withInput: (state: S, input: string) => S;
  /** Cleans state read back from localStorage (it may be anything). */
  restore: (raw: unknown) => S;
  /** What of the state goes to localStorage (with `persist`); all of it when absent. */
  serialize?: (state: S) => unknown;
}

/** Keeps a tool's own state type inside the registry while the list stays uniform. */
function defineTool<S>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export const TOOLS: readonly ToolDef[] = [
  defineTool<JwtState>({
    id: "jwt",
    label: "JWT decoder",
    description: "Read a token's header, payload and expiry.",
    icon: KeyRound,
    keywords: ["jwt", "token", "bearer", "decode", "claims", "jws", "expiry"],
    persist: false,
    component: lazy(() => loadJwtTool().then((m) => ({ default: m.JwtTool }))),
    initialState: (input) => jwtInitialState(input),
    withInput: (state, input) => ({ ...state, token: input, revealed: {} }),
    restore: restoreJwtState,
  }),
  defineTool<JsonToolState>({
    id: "json",
    label: "JSON formatter",
    description: "Format, minify or sort JSON, and escape it into a string.",
    icon: Braces,
    keywords: [
      "json",
      "format",
      "pretty",
      "beautify",
      "minify",
      "sort keys",
      "escape",
      "unescape",
      "validate",
    ],
    persist: true,
    component: lazy(() => loadJsonTool().then((m) => ({ default: m.JsonTool }))),
    initialState: (input) => jsonInitialState(input),
    withInput: jsonWithInput,
    restore: restoreJsonState,
    serialize: serializeJsonState,
  }),
  defineTool<UrlToolState>({
    id: "url",
    label: "URL encoder",
    description: "Encode or decode URL text, and read a URL's parts.",
    icon: Link,
    keywords: ["url", "uri", "encode", "decode", "percent", "escape", "query", "form", "parse"],
    persist: true,
    component: lazy(() => loadUrlTool().then((m) => ({ default: m.UrlTool }))),
    initialState: (input) => urlInitialState(input),
    withInput: urlWithInput,
    restore: restoreUrlState,
    serialize: serializeUrlState,
  }),
];

/** The tool with this id, or undefined (e.g. an id from an older build's localStorage). */
export function toolDef(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}
