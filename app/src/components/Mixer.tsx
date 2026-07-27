import {
  effectiveParamValue,
  instrumentParams,
  type InstrumentDoc,
  type InstrumentParam,
  type Project,
} from "@chord-garden/format/pure";
import { useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import { channels } from "../view/instruments";
import {
  axisFor,
  axisOffset,
  clampTrim,
  dbfsLabel,
  draggedAxisValue,
  keyboardStep,
  mixerLanes,
  paramValueLabel,
  trimBounds,
  valuePerPixel,
  type MixerLane,
} from "../view/mixer";
import type { InstrumentParamPatch } from "../store/documentStore";
import { DraftField } from "./DraftField";
import { MasterMeter } from "./MasterMeter";
import { useParamApply } from "./ParamControl";
import { useDragState } from "./useDragState";

/**
 * The mixer: a strip per track, with a fader and a pan for the instrument that
 * track plays.
 *
 * **It is a view, not a section of the format.** `gain` and `pan` are already
 * instrument params in the registry (docs/format-spec.md §6), so nothing here
 * persists anything new — every control writes the same `instruments/<id>.json`
 * the instrument editor writes, and a fader moved in one shows up in the other and
 * in a `musictool describe` immediately. There is deliberately no mixer document,
 * because a second place to store a level is a second thing that can disagree with
 * the one the renderer reads.
 *
 * Two consequences of that framing are visible on screen rather than hidden,
 * because they are the places where a musician's expectation and the format part
 * company:
 *
 * **A level belongs to an instrument, not to a track.** Two tracks may name the
 * same `instruments/<id>.json`, and then one fader moves both — so a strip whose
 * instrument is shared says so, by name. The alternative would be a fader that
 * silently moves a track you are not looking at.
 *
 * **A drum kit has no single output level.** The registry gives `drumkit` per-voice
 * params only; there is no kit-wide `gain` to draw. So the strip draws a fader per
 * voice and, above them, a *trim* — which is a gesture rather than a stored value:
 * it moves every voice's own `gain` by the same number of decibels, and stops at
 * whichever voice reaches the end of its range first so the balance between them
 * survives the trip. It reads `0.00 dB` again as soon as you let go, because there
 * is nothing in the file for it to remember, and it says so.
 *
 * Nothing here limits or compensates for anything. PLAN.md §6.3 makes headroom the
 * author's job, so pushing the master past 0 dBFS is the mixer working; the meter
 * says by how much, and `musictool render --analyze` says the same number as a
 * warning.
 */
export function Mixer({ project }: { project: Project }): React.JSX.Element {
  const strips = channels(project);

  return (
    <section>
      <h2>mixer</h2>
      <p className="muted">
        a view over the instrument params, not a section of its own: a fader here writes{" "}
        <code>gain</code> in <code>instruments/&lt;id&gt;.json</code>, the same value the instruments section and{" "}
        <code>musictool render</code> read. drag a cap, or use the arrow keys (shift for one unit); the number under
        each control is typeable.
      </p>
      <MasterMeter />
      <div className="mixer">
        {strips.map((strip) => (
          <div className="strip" key={strip.trackId}>
            <div className="strip-head">
              <strong>{strip.trackId}</strong>
              <span className="muted">{strip.instrumentId}</span>
            </div>
            {strip.instrument === undefined ? (
              <p className="error">instrument &quot;{strip.instrumentId}&quot; did not load</p>
            ) : (
              <ChannelControls instrument={strip.instrument} sharedWith={strip.sharedWith} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Height of a fader's travel, and width of a pan slider's, in CSS pixels. */
const FADER_PX = 140;
const PAN_PX = 96;

function ChannelControls({
  instrument,
  sharedWith,
}: {
  instrument: InstrumentDoc;
  sharedWith: readonly string[];
}): React.JSX.Element {
  const [error, setError] = useState<string | undefined>(undefined);
  const params = instrumentParams(instrument);
  const lanes = mixerLanes(params);
  const levels = lanes.flatMap((lane) => lane.levels);

  return (
    <>
      {sharedWith.length > 0 && (
        <p className="warn">
          shares {instrument.id} with {sharedWith.join(", ")} — these controls move{" "}
          {sharedWith.length === 1 ? "that track" : "those tracks"} too, because the level lives on the instrument.
        </p>
      )}
      <div className="strip-lanes">
        {levels.length > 1 && <KitTrim instrument={instrument} levels={levels} onError={setError} />}
        {lanes.map((lane) => (
          <LaneControls key={lane.voice} instrument={instrument} lane={lane} onError={setError} />
        ))}
      </div>
      {lanes.length === 0 && <p className="muted">this instrument declares no level or pan param.</p>}
      {error !== undefined && <p className="error">{error}</p>}
    </>
  );
}

function LaneControls({
  instrument,
  lane,
  onError,
}: {
  instrument: InstrumentDoc;
  lane: MixerLane;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  return (
    <div className="strip-lane">
      {lane.voice !== "" && <span className="strip-lane-name">{lane.voice}</span>}
      {lane.levels.map((param) => (
        <AxisControl
          key={param.key}
          instrument={instrument}
          param={param}
          orientation="vertical"
          length={FADER_PX}
          onError={onError}
        />
      ))}
      {lane.pans.map((param) => (
        <AxisControl
          key={param.key}
          instrument={instrument}
          param={param}
          orientation="horizontal"
          length={PAN_PX}
          onError={onError}
        />
      ))}
    </div>
  );
}

/** A drag of a fader cap or a pan handle, until it is released. */
interface AxisDrag {
  origin: number;
  from: number;
  value: number;
}

/**
 * One draggable control for one param: a vertical fader or a horizontal slider.
 *
 * The two orientations are one component because they are one behaviour — a value
 * on an axis, moved one pixel of value per pixel of pointer — and only the sign and
 * the CSS property differ. Splitting them would be two copies of the drag protocol
 * below, which is the code most worth having exactly once.
 *
 * The drag state lives in the ref the handlers read, never in the rendered copy.
 * That is not a style preference: a `pointermove` that arrives before React has
 * re-rendered would see the previous render's `undefined` and bail out, so a slow
 * drag would work and a fast one would silently do nothing. See `useDragState`,
 * where that bug is written up; it has already happened in this app once.
 *
 * The document is written when the drag ends, not on every pointer sample, exactly
 * as the automation editor commits a dragged breakpoint. Every edit recompiles the
 * whole schedule and pushes it to the worklet, so committing per pixel would queue
 * a few hundred recompiles behind a single gesture. The cost is that a fader is
 * heard when it is released rather than continuously; typing a number or pressing
 * an arrow key is heard at once.
 */
function AxisControl({
  instrument,
  param,
  orientation,
  length,
  onError,
}: {
  instrument: InstrumentDoc;
  param: InstrumentParam;
  orientation: "vertical" | "horizontal";
  length: number;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const apply = useParamApply(instrument, param.key, onError);
  const { shown: drag, ref: dragRef, set: setDrag } = useDragState<AxisDrag>();

  const axis = axisFor(param.spec, param.key, length);
  const committed = effectiveParamValue(instrument, param.key);
  if (typeof committed !== "number") {
    throw new Error(`cannot draw a mixer control for "${param.key}": its value is not a number`);
  }
  const value = drag === undefined ? committed : drag.value;
  const offset = axisOffset(value, axis);
  const defaultOffset = axisOffset(typeof param.spec.default === "number" ? param.spec.default : axis.min, axis);
  const overridden = instrument.params?.[param.key] !== undefined;
  const label = `${instrument.id} ${param.key}`;
  const readout = paramValueLabel(param.spec, value);

  /** Pointer movement towards `max`: up on a fader, right on a slider. */
  function towardsMax(event: { clientX: number; clientY: number }, origin: number): number {
    return orientation === "vertical" ? origin - event.clientY : event.clientX - origin;
  }

  return (
    <div className={`axis axis-${orientation}${overridden ? " overridden" : ""}`}>
      <div
        className="axis-track"
        style={orientation === "vertical" ? { height: length } : { width: length }}
        aria-hidden="true"
      >
        <span
          className="axis-default"
          style={orientation === "vertical" ? { bottom: defaultOffset } : { left: defaultOffset }}
        />
        <span
          className="axis-fill"
          style={orientation === "vertical" ? { height: offset } : { width: offset }}
        />
        <button
          type="button"
          className="axis-cap"
          style={orientation === "vertical" ? { bottom: offset } : { left: offset }}
          aria-label={`${label} — ${readout}`}
          title={`${param.key} — ${readout}. drag, or arrow keys (shift for one ${param.spec.unit === "dB100" ? "hundredth of a dB" : "unit"}).`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({
              origin: orientation === "vertical" ? event.clientY : event.clientX,
              from: committed,
              value: committed,
            });
          }}
          onPointerMove={(event) => {
            // `dragRef`, never `drag`: see `useDragState`.
            const active = dragRef.current;
            if (active === undefined) return;
            const next = draggedAxisValue(active.from, towardsMax(event, active.origin), axis);
            if (next === active.value) return;
            setDrag({ ...active, value: next });
          }}
          onPointerUp={() => {
            const finished = dragRef.current;
            setDrag(undefined);
            if (finished === undefined || finished.value === committed) return;
            apply(finished.value);
          }}
          onPointerCancel={() => setDrag(undefined)}
          onKeyDown={(event) => {
            const step = keyboardStep(axis, event.shiftKey);
            const delta =
              event.key === "ArrowUp" || event.key === "ArrowRight"
                ? step
                : event.key === "ArrowDown" || event.key === "ArrowLeft"
                  ? -step
                  : 0;
            if (delta === 0) return;
            event.preventDefault();
            const next = Math.max(axis.min, Math.min(axis.max, committed + delta));
            if (next !== committed) apply(next);
          }}
        />
      </div>
      {/* The voice already names itself to the left of the row, so a per-voice
          control says `gain` rather than `kick.gain`. */}
      <span className="axis-label">
        {param.voice === undefined ? param.key : param.key.slice(param.voice.length + 1)}
      </span>
      <DraftField
        kind="number"
        label={`${label} value`}
        size={5}
        value={String(committed)}
        onCommit={(text) => {
          if (text.trim() === "") {
            apply(undefined);
            return;
          }
          const typed = Number(text);
          if (!Number.isFinite(typed)) {
            onError(`"${text}" is not a number`);
            return;
          }
          apply(typed);
        }}
      />
      <span className="muted axis-readout">{readout}</span>
    </div>
  );
}

/** A whole-group trim in progress. */
interface TrimDrag {
  origin: number;
  delta: number;
}

/**
 * One fader that moves every level of the instrument by the same amount.
 *
 * It exists because of a gap the mixer-as-a-view framing has and cannot close
 * without a format change: `drumkit` declares per-voice params only, so a kit has
 * no single output level to put a fader on, and pulling the drums down 3 dB would
 * otherwise mean editing every voice by hand and keeping the arithmetic straight.
 *
 * It is honest about being a gesture rather than a value. It always reads 0 dB at
 * rest, because nothing in the file holds a trim; what it writes is each voice's
 * own `gain`, in one edit, so the diff says exactly what changed and an agent
 * reading the file afterwards sees per-voice levels and no invented concept.
 */
function KitTrim({
  instrument,
  levels,
  onError,
}: {
  instrument: InstrumentDoc;
  levels: readonly InstrumentParam[];
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const setInstrumentParams = useStore(documentStore, (state) => state.setInstrumentParams);
  const { shown: drag, ref: dragRef, set: setDrag } = useDragState<TrimDrag>();

  const spec = levels[0]!.spec;
  const axis = axisFor(spec, levels[0]!.key, FADER_PX);
  const current = levels.map((param) => {
    const value = effectiveParamValue(instrument, param.key);
    if (typeof value !== "number") throw new Error(`cannot trim "${param.key}": its value is not a number`);
    return value;
  });
  const bounds = trimBounds(current, spec, levels[0]!.key);
  const delta = drag?.delta ?? 0;
  const perPx = valuePerPixel(axis);
  // A trim has no value of its own to sit at, so its cap rests in the middle of the
  // track and moves with the pointer at exactly the sensitivity of the faders below
  // it — the same number of decibels for the same movement of the hand.
  const rest = FADER_PX / 2;
  const offset = Math.max(0, Math.min(FADER_PX, rest + (perPx === 0 ? 0 : delta / perPx)));

  function commit(applied: number): void {
    if (applied === 0) return;
    const patch: InstrumentParamPatch = {};
    levels.forEach((param, index) => {
      patch[param.key] = current[index]! + applied;
    });
    try {
      setInstrumentParams(instrument.id, patch);
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className={`axis axis-vertical trim${delta === 0 ? "" : " overridden"}`}>
      <div className="axis-track" style={{ height: FADER_PX }} aria-hidden="true">
        <span className="axis-default" style={{ bottom: rest }} />
        <span className="axis-fill" style={{ height: offset }} />
        <button
          type="button"
          className="axis-cap"
          style={{ bottom: offset }}
          aria-label={`${instrument.id} trim — ${paramValueLabel(spec, delta)}`}
          title={`moves all ${levels.length} levels together by the same amount; stops where the first of them reaches its range. Nothing stores a trim, so it returns to 0 when released.`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ origin: event.clientY, delta: 0 });
          }}
          onPointerMove={(event) => {
            const active = dragRef.current;
            if (active === undefined) return;
            const next = clampTrim((active.origin - event.clientY) * perPx, bounds);
            if (next === active.delta) return;
            setDrag({ ...active, delta: next });
          }}
          onPointerUp={() => {
            const finished = dragRef.current;
            setDrag(undefined);
            if (finished === undefined) return;
            commit(finished.delta);
          }}
          onPointerCancel={() => setDrag(undefined)}
          onKeyDown={(event) => {
            const step = keyboardStep(axis, event.shiftKey);
            const move =
              event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
            if (move === 0) return;
            event.preventDefault();
            commit(clampTrim(move, bounds));
          }}
        />
      </div>
      <span className="axis-label">trim</span>
      <span className="muted axis-readout">
        {paramValueLabel(spec, delta)}
        <br />
        {levels.length} levels
      </span>
    </div>
  );
}

