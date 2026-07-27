import {
  automatableParams,
  describeParamRange,
  resolveParam,
  staticParamValue,
  ticksPerBar,
  type AutomationInterp,
  type AutomationLane,
  type InstrumentDoc,
  type Project,
} from "@chord-garden/format/pure";
import { memo, useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import {
  AUTOMATION_ZOOMS,
  automationBounds,
  automationPxPerTick,
  clampAutomationPoint,
  curveOf,
  polylinePoints,
  tickToX,
  valueToY,
  xToTick,
  yToValue,
  type AutomationGeometry,
} from "../view/automation";
import { DraftField } from "./DraftField";
import { SongPlayhead } from "./Playhead";
import { useDragState } from "./useDragState";

/**
 * Automation lanes: a breakpoint curve per automatable param, per track.
 *
 * Three decisions shape this file.
 *
 * **The registry decides what can be automated, and nothing here has an opinion.**
 * The param picker is `automatableParams(instrument)`, the vertical axis is that
 * param's own `min`/`max`, the unit beside every box is `describeParamRange`, and
 * a new lane starts at `staticParamValue` — the value the instrument already
 * produces. No param name, range, unit or default is written down in this file.
 * Add a param to `packages/format/src/registry.ts` with `automatable: true` and
 * it appears here with the right axis and the right unit, with nothing in the UI
 * edited.
 *
 * **This canvas is song time, not pattern time.** Automation is per track and
 * spans the arrangement (docs/format-spec.md §7), which is why it is its own
 * section rather than a strip under a pattern: a pattern played by four clips has
 * four places on this curve, and drawing the curve inside the pattern would have
 * to pick one. The default zoom fits the whole arrangement for the same reason —
 * the shape of a sweep across the song is the thing you are looking at.
 *
 * **The curve is drawn the way the engine reads it.** Before the first
 * breakpoint a lane does not apply at all and the instrument's static value is
 * what sounds (`AutomationRamps.update`), so that stretch is drawn dashed at the
 * static value rather than flat at the first point's. A `step` lane is drawn as
 * a staircase. Anything else would be a picture of a curve the renderer is not
 * playing.
 */

/** Height of one lane's value area, in CSS pixels. */
const LANE_HEIGHT = 92;
/** Width the "fit the whole arrangement" zoom aims at. */
const FIT_WIDTH = 900;

export function AutomationEditors({ project }: { project: Project }): React.JSX.Element {
  return (
    <section>
      <h2>automation</h2>
      <p className="muted">
        breakpoints in song time, in each param&rsquo;s own unit. click the curve to add a point, drag one to move it,
        select one to type exact numbers or remove it.
      </p>
      {project.project.trackOrder.map((trackId) => {
        const track = project.tracks.get(trackId);
        if (track === undefined) return null;
        const instrument = project.instruments.get(track.instrument);
        if (instrument === undefined) {
          return (
            <p key={trackId} className="error">
              track &quot;{trackId}&quot; names instrument &quot;{track.instrument}&quot;, which did not load
            </p>
          );
        }
        return <TrackAutomation key={trackId} project={project} trackId={trackId} instrument={instrument} />;
      })}
    </section>
  );
}

function TrackAutomation({
  project,
  trackId,
  instrument,
}: {
  project: Project;
  trackId: string;
  instrument: InstrumentDoc;
}): React.JSX.Element {
  const addAutomationLane = useStore(documentStore, (state) => state.addAutomationLane);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | undefined>(undefined);

  const lanes = project.automation.get(trackId)?.lanes ?? [];
  const used = new Set(lanes.map((lane) => lane.param));
  const available = automatableParams(instrument).filter((param) => !used.has(param.key));
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const target = chosen !== undefined && available.some((param) => param.key === chosen) ? chosen : available[0]?.key;

  const lengthTicks = project.arrangement.lengthTicks;
  const pxPerTick = automationPxPerTick(lengthTicks, FIT_WIDTH, zoom);
  const barTicks = ticksPerBar(project.project.ppqn, project.project.meterMap[0]!.timeSignature);

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <strong>{trackId}</strong>
        <label>
          add lane
          <select
            value={target ?? ""}
            disabled={available.length === 0}
            onChange={(event) => setChosen(event.target.value)}
          >
            {available.length === 0 ? (
              <option value="">every automatable param already has a lane</option>
            ) : (
              available.map((param) => (
                <option key={param.key} value={param.key}>
                  {param.key} ({describeParamRange(param.spec)})
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          disabled={target === undefined}
          onClick={() => {
            if (target === undefined) return;
            try {
              addAutomationLane(trackId, target);
              setError(undefined);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          add
        </button>
        {lanes.length > 0 && (
          <label>
            zoom
            <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
              {AUTOMATION_ZOOMS.map((level) => (
                <option key={level} value={level}>
                  {level === 1 ? "fit" : `${level}×`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {lanes.length === 0 ? (
        <p className="muted">no automation on this track.</p>
      ) : (
        lanes.map((lane) => (
          <LaneEditor
            key={lane.param}
            project={project}
            trackId={trackId}
            instrument={instrument}
            lane={lane}
            pxPerTick={pxPerTick}
            barTicks={barTicks}
            onError={setError}
          />
        ))
      )}
      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}

interface PointDrag {
  index: number;
  tick: number;
  value: number;
}

function LaneEditor({
  project,
  trackId,
  instrument,
  lane,
  pxPerTick,
  barTicks,
  onError,
}: {
  project: Project;
  trackId: string;
  instrument: InstrumentDoc;
  lane: AutomationLane;
  pxPerTick: number;
  barTicks: number;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const removeAutomationLane = useStore(documentStore, (state) => state.removeAutomationLane);
  const setAutomationInterp = useStore(documentStore, (state) => state.setAutomationInterp);
  const addAutomationPoint = useStore(documentStore, (state) => state.addAutomationPoint);
  const moveAutomationPoint = useStore(documentStore, (state) => state.moveAutomationPoint);
  const removeAutomationPoint = useStore(documentStore, (state) => state.removeAutomationPoint);

  const [selected, setSelected] = useState<number | undefined>(undefined);
  const { shown: drag, ref: dragRef, set: setDrag } = useDragState<PointDrag>();

  const resolved = resolveParam(instrument, lane.param);
  if (resolved === undefined) {
    // A document `validate` reports as `registry.unknown-param`. Shown rather
    // than skipped: a lane nothing draws is a lane nobody can delete.
    return (
      <p className="error">
        lane &quot;{lane.param}&quot; targets a param instrument &quot;{instrument.id}&quot; does not have
      </p>
    );
  }
  const bounds = automationBounds(resolved.spec, lane.param);
  const geometry: AutomationGeometry = { pxPerTick, height: LANE_HEIGHT, ...bounds };
  const lengthTicks = project.arrangement.lengthTicks;
  const width = tickToX(lengthTicks, geometry);
  const fallback = staticParamValue(instrument, lane.param) ?? bounds.min;

  // What is on screen right now: the document, with the point being dragged
  // moved. Kept out of the document so a drag is one edit at the end rather than
  // one per pointer sample.
  const shown: AutomationLane =
    drag === undefined
      ? lane
      : { ...lane, points: lane.points.map((point, index) => (index === drag.index ? [drag.tick, drag.value] : point)) };
  const curve = curveOf(shown, fallback, geometry, lengthTicks);

  function attempt(action: () => void): void {
    try {
      action();
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Where a pointer is, in ticks and in the param's unit. Takes the coordinates
   * rather than an event type so a click and a drag reach it the same way.
   */
  function pointerPosition(at: { clientX: number; clientY: number }, element: Element): { tick: number; value: number } {
    const box = element.getBoundingClientRect();
    return {
      tick: xToTick(at.clientX - box.left, geometry, lengthTicks),
      value: yToValue(at.clientY - box.top, geometry),
    };
  }

  const selectedPoint = selected === undefined ? undefined : lane.points[selected];

  return (
    <div className="auto-lane">
      <div className="auto-head">
        <strong>{lane.param}</strong>
        <span className="muted">{describeParamRange(resolved.spec)}</span>
        <label>
          interp
          <select
            value={lane.interp}
            onChange={(event) => {
              const interp = event.target.value as AutomationInterp;
              attempt(() => setAutomationInterp(trackId, lane.param, interp));
            }}
          >
            <option value="linear">linear</option>
            <option value="step">step</option>
          </select>
        </label>
        <span className="muted">{lane.points.length} points</span>
        <button
          type="button"
          onClick={() => {
            setSelected(undefined);
            attempt(() => removeAutomationLane(trackId, lane.param));
          }}
        >
          remove lane
        </button>
      </div>
      <div className="auto-grid">
        <div className="auto-axis">
          <span>{bounds.max}</span>
          <span className="muted">{resolved.spec.unit === "enum" ? "" : resolved.spec.unit}</span>
          <span>{bounds.min}</span>
        </div>
        <div className="lane-scroll">
          <div className="auto-canvas" style={{ width, height: LANE_HEIGHT }}>
            <svg
              width={width}
              height={LANE_HEIGHT}
              // A click on empty canvas adds a point; a click that finished a
              // drag does not, because the drag handler stops it.
              onClick={(event) => {
                const { tick, value } = pointerPosition(event, event.currentTarget);
                attempt(() => addAutomationPoint(trackId, lane.param, tick, value));
              }}
            >
              <BarLines bars={lengthTicks / barTicks} barPx={barTicks * pxPerTick} height={LANE_HEIGHT} />
              {curve.before.length > 0 && (
                <polyline
                  className="auto-curve-before"
                  points={polylinePoints(curve.before)}
                  fill="none"
                >
                  <title>
                    before the first breakpoint this lane does not apply; the instrument&rsquo;s own {lane.param} of{" "}
                    {fallback} is what sounds
                  </title>
                </polyline>
              )}
              <polyline className="auto-curve" points={polylinePoints(curve.after)} fill="none" />
              {shown.points.map((point, index) => (
                <circle
                  key={index}
                  className={`auto-point${selected === index ? " selected" : ""}`}
                  cx={tickToX(point[0], geometry)}
                  cy={valueToY(point[1], geometry)}
                  r={selected === index ? 6 : 5}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setSelected(index);
                    setDrag({ index, tick: point[0], value: point[1] });
                  }}
                  onPointerMove={(event) => {
                    // `dragRef`, never the `drag` from this render: a pointermove
                    // that beats React's re-render would otherwise see no drag.
                    const active = dragRef.current;
                    if (active?.index !== index) return;
                    const svg = event.currentTarget.ownerSVGElement;
                    if (svg === null) return;
                    const at = pointerPosition(event, svg);
                    const [tick, value] = clampAutomationPoint(
                      lane,
                      index,
                      at.tick,
                      at.value,
                      geometry,
                      lengthTicks,
                    );
                    if (tick === active.tick && value === active.value) return;
                    setDrag({ index, tick, value });
                  }}
                  onPointerUp={(event) => {
                    event.stopPropagation();
                    const moving = dragRef.current;
                    setDrag(undefined);
                    if (moving?.index !== index) return;
                    if (moving.tick === point[0] && moving.value === point[1]) return;
                    attempt(() => moveAutomationPoint(trackId, lane.param, index, moving.tick, moving.value));
                  }}
                  onPointerCancel={() => setDrag(undefined)}
                  onClick={(event) => event.stopPropagation()}
                >
                  <title>
                    tick {point[0]}, {lane.param} {point[1]}
                  </title>
                </circle>
              ))}
            </svg>
            <SongPlayhead project={project} pxPerTick={pxPerTick} />
          </div>
        </div>
      </div>
      {selectedPoint === undefined ? (
        <p className="muted">no point selected.</p>
      ) : (
        <div className="inspector">
          <div className="inspector-head">
            <strong>
              {lane.param} point {selected}
            </strong>
            <span className="muted">
              bar {(selectedPoint[0] / barTicks + 1).toFixed(2)} of {lengthTicks / barTicks}
            </span>
            <button
              type="button"
              onClick={() => {
                const at = selected;
                if (at === undefined) return;
                setSelected(undefined);
                attempt(() => removeAutomationPoint(trackId, lane.param, at));
              }}
            >
              remove point
            </button>
          </div>
          <div className="fields">
            <label>
              tick
              <DraftField
                kind="number"
                label={`${lane.param} point ${selected} tick`}
                value={String(selectedPoint[0])}
                onCommit={(text) => {
                  if (text.trim() === "" || selected === undefined) return;
                  attempt(() => moveAutomationPoint(trackId, lane.param, selected, Number(text), selectedPoint[1]));
                }}
              />
              <span className="muted">ticks 0..{lengthTicks}</span>
            </label>
            <label>
              value
              <DraftField
                kind="number"
                label={`${lane.param} point ${selected} value`}
                value={String(selectedPoint[1])}
                onCommit={(text) => {
                  if (text.trim() === "" || selected === undefined) return;
                  attempt(() => moveAutomationPoint(trackId, lane.param, selected, selectedPoint[0], Number(text)));
                }}
              />
              <span className="muted">{describeParamRange(resolved.spec)}</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

const BarLines = memo(function BarLines({
  bars,
  barPx,
  height,
}: {
  bars: number;
  barPx: number;
  height: number;
}): React.JSX.Element {
  return (
    <>
      {Array.from({ length: Math.max(0, Math.ceil(bars)) }, (_unused, bar) => (
        <line key={bar} className="auto-bar" x1={bar * barPx} x2={bar * barPx} y1={0} y2={height} />
      ))}
    </>
  );
});
