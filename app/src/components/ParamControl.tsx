import {
  describeParamRange,
  effectiveParamValue,
  type InstrumentDoc,
  type InstrumentParam,
} from "@chord-garden/format/pure";
import { useStore } from "zustand";
import { documentStore } from "../session";
import { DraftField } from "./DraftField";

/**
 * One instrument param, as whatever control its registry entry calls for.
 *
 * The whole file knows two things about params: an `enum` is a choice from
 * `spec.values`, and everything else is an integer in `spec.min..spec.max`. No
 * param name appears here, or anywhere else under `app/src` — the caller hands
 * over an `InstrumentParam` from `instrumentParams(instrument)`, and the unit,
 * range, default and enum values all come off the spec. A param added to
 * `packages/format/src/registry.ts` becomes editable with nothing in the UI
 * touched, and one removed stops being offered.
 *
 * Two behaviours are worth stating because they are what keeps files small, and
 * they are the same two the step sequencer's velocity drag follows:
 *
 * **An empty box means the default.** The default is the placeholder, so a param
 * the instrument does not set reads as "inherits 12000" rather than as blank or as
 * a number the author did not write. Emptying the box clears the override.
 *
 * **Setting the default clears the override.** Typing the registry's own value, or
 * choosing the enum's default from the list, removes the key rather than writing a
 * number equal to the default. That rule lives in the store, so it holds for every
 * caller and not only for this control; here it is only made visible, by the
 * override marker going away.
 */
export function ParamControl({
  instrument,
  param,
  label,
  onError,
}: {
  instrument: InstrumentDoc;
  param: InstrumentParam;
  /** What to call it here; a per-voice group shows `gain`, not `kick.gain`. */
  label: string;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const apply = useParamApply(instrument, param.key, onError);
  const override = instrument.params?.[param.key];
  const effective = effectiveParamValue(instrument, param.key);
  const field = `${instrument.id} ${param.key}`;

  return (
    <label className={override === undefined ? "param" : "param overridden"}>
      <span className="param-name">{label}</span>
      {param.spec.unit === "enum" ? (
        <select
          value={String(effective)}
          aria-label={field}
          onChange={(event) => {
            apply(event.target.value);
          }}
        >
          {(param.spec.values ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
              {value === param.spec.default ? " (default)" : ""}
            </option>
          ))}
        </select>
      ) : (
        <DraftField
          kind="number"
          label={field}
          value={override === undefined ? "" : String(override)}
          placeholder={String(param.spec.default)}
          onCommit={(text) => {
            if (text.trim() === "") {
              apply(undefined);
              return;
            }
            const value = Number(text);
            if (!Number.isFinite(value)) {
              onError(`"${text}" is not a number`);
              return;
            }
            apply(value);
          }}
        />
      )}
      <span className="muted">{describeParamRange(param.spec)}</span>
    </label>
  );
}

/**
 * Commit a value for one param, turning a refusal into a message instead of an
 * exception.
 *
 * Shared by every control that writes a param — the fields here and the mixer's
 * faders — so "clearing means `undefined`" and "a refusal is shown, not thrown" are
 * stated once. Two copies of this is how one surface ends up silently swallowing
 * the store's refusal while the other reports it.
 */
export function useParamApply(
  instrument: InstrumentDoc,
  key: string,
  onError: (message: string | undefined) => void,
): (value: number | string | undefined) => void {
  const setInstrumentParam = useStore(documentStore, (state) => state.setInstrumentParam);
  return (value) => {
    try {
      setInstrumentParam(instrument.id, key, value);
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };
}
