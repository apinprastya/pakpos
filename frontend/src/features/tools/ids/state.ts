import type { IdKind } from "./ids";

/** The ID generator tab's state. */
export interface IdsState {
  kind: IdKind;
  /** The count field as typed (validated with `parseCount`). */
  count: string;
  upper: boolean;
  /** UUIDs only. */
  hyphens: boolean;
  /** The Inspect field. */
  inspect: string;
  /**
   * The last batch in canonical form and the kind it was made for. Not
   * persisted: a reopened tab generates a fresh batch.
   */
  generated: { kind: IdKind; ids: string[] } | null;
}

const KINDS: IdKind[] = ["uuid4", "uuid7", "ulid"];

export function idsInitialState(input = ""): IdsState {
  return { kind: "uuid4", count: "1", upper: false, hyphens: true, inspect: input, generated: null };
}

/** An entry point's input goes to the Inspect field. */
export function idsWithInput(state: IdsState, input: string): IdsState {
  return { ...state, inspect: input };
}

/** What goes to localStorage: the options and the Inspect field, not the generated IDs. */
export function serializeIdsState(state: IdsState): Omit<IdsState, "generated"> {
  return {
    kind: state.kind,
    count: state.count,
    upper: state.upper,
    hyphens: state.hyphens,
    inspect: state.inspect,
  };
}

export function restoreIdsState(raw: unknown): IdsState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof IdsState, unknown>>;
  const d = idsInitialState();
  return {
    kind: KINDS.includes(r.kind as IdKind) ? (r.kind as IdKind) : d.kind,
    count: typeof r.count === "string" ? r.count : d.count,
    upper: typeof r.upper === "boolean" ? r.upper : d.upper,
    hyphens: typeof r.hyphens === "boolean" ? r.hyphens : d.hyphens,
    inspect: typeof r.inspect === "string" ? r.inspect : d.inspect,
    generated: null,
  };
}
