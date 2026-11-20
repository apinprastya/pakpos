import type { UnitOverride } from "./timestamp";

/** The timestamp converter tab's state; kept with the tabs (it's never sensitive). */
export interface TimestampState {
  input: string;
  /** How a number is read; "auto" picks from its size. */
  unit: UnitOverride;
  /** IANA time zone for the zoned outputs; "" means the system zone. */
  zone: string;
}

const UNITS: UnitOverride[] = ["auto", "s", "ms", "us", "ns"];

export function timestampInitialState(input = ""): TimestampState {
  return { input, unit: "auto", zone: "" };
}

/** New input from an entry point; the unit and zone choices stay. */
export function timestampWithInput(state: TimestampState, input: string): TimestampState {
  return { ...state, input };
}

export function restoreTimestampState(raw: unknown): TimestampState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof TimestampState, unknown>>;
  const d = timestampInitialState();
  return {
    // A timestamp is short; anything long isn't one worth keeping.
    input: typeof r.input === "string" && r.input.length <= 1000 ? r.input : d.input,
    unit: UNITS.includes(r.unit as UnitOverride) ? (r.unit as UnitOverride) : d.unit,
    zone: typeof r.zone === "string" ? r.zone : d.zone,
  };
}
