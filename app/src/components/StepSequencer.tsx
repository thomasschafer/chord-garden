import {
  describeExpressionRange,
  LANE_DEFAULT_FIELDS,
  parseSteps,
  STEP_EVENT_FIELDS,
  ticksPerBar,
  type DrumkitInstrumentDoc,
  type GridLane,
  type GridPatternDoc,
  type LaneDefaultField,
  type Project,
  type StepEvent,
  type StepEventField,
} from "@chord-garden/format/pure";
import { memo, useCallback, useRef, useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import type { LaneDefaultsPatch, StepEventPatch } from "../store/documentStore";
import { gridGeometry } from "../view/grid";
import {
  DRAG_THRESHOLD_PX,
  draggedVelocity,
  effectiveStepValue,
  expressionFraction,
  formatDefault,
  inheritedStepValue,
  laneSwing,
  swingEffect,
  type LaneContext,
} from "../view/expression";
import { DraftField } from "./DraftField";
import { PatternPlayhead } from "./Playhead";
import { useDragState } from "./useDragState";

/**
 * A step sequencer for one grid pattern: a lane per kit voice, a cell per step.
 *
 * Four rules shape the whole file.
 *
 * **The string is never touched.** `steps` has its own grammar in which spaces and
 * `|` are not steps (docs/format-spec.md §5), so a cell knows its step *index* and
 * nothing else; the store parses the lane with `parseSteps`, toggles a member of the
 * hit set, and re-emits the string with `formatSteps`. No character offset into
 * `steps` appears anywhere in the UI, which is the only way to be sure the cell you
 * clicked is the step that moved.
 *
 * **Nothing in the document is hidden.** A step carrying `stepEvents` overrides is
 * marked, its overrides are listed when it is selected, and they are editable there.
 * The alternative — a grid that shows only where hits are — would quietly present a
 * different document to the human than the one the agent sees, and PLAN.md §3 makes
 * them peers.
 *
 * **Velocity is visible and draggable.** Every hit is filled to its effective
 * velocity, so the dynamics of a lane are a shape rather than a column of
 * numbers you have to open one at a time, and dragging a hit up or down writes
 * it. Dragging back to the value the step was inheriting *removes* the override
 * instead of restating it, which is what keeps a file's `stepEvents` as sparse
 * as the author's intent.
 *
 * **Swing explains itself.** Only odd-indexed steps move (docs/format-spec.md
 * §4), so the lane panel says how many of this lane's hits that is. "0 of 4 hits
 * move" is why a four-on-the-floor kick does not change, stated as a fact about
 * the lane rather than a warning nobody reads.
 */
export function StepSequencer({
  project,
  trackId,
  pattern,
  kit,
}: {
  project: Project;
  /** The track that plays this pattern; the playhead is only defined through it. */
  trackId: string;
  pattern: GridPatternDoc;
  kit: DrumkitInstrumentDoc;
}): React.JSX.Element {
  const toggleGridStep = useStore(documentStore, (state) => state.toggleGridStep);
  const setStepEvent = useStore(documentStore, (state) => state.setStepEvent);
  const [selected, setSelected] = useState<Selection | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const geometry = gridGeometry(project);
  const bars = pattern.lengthTicks / geometry.barTicks;
  const lanesByVoice = new Map(pattern.lanes.map((lane) => [lane.lane, lane]));
  // Lanes for voices this kit does not have are not legal (`validate` reports
  // `pattern.lane-unknown-voice`), but if a document on disk has one, showing it is
  // how it gets fixed.
  const rows = [
    ...Object.keys(kit.kit)
      .sort()
      .map((voice) => ({ voice, lane: lanesByVoice.get(voice) })),
    ...pattern.lanes.filter((lane) => !(lane.lane in kit.kit)).map((lane) => ({ voice: lane.lane, lane })),
  ];

  const patternId = pattern.id;
  const projectSwing = project.project.swing;

  function attempt(action: () => void): void {
    try {
      action();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Stable across renders, so the memo on `LaneRow` can actually bail out. A fresh
   * arrow function per row per render would make every cell in the pattern re-render
   * on each of the ~47 position reports a second, which is what the memo is there to
   * prevent.
   */
  const onToggle = useCallback(
    (voice: string, step: number, stepsPerBar: number) => {
      setSelected({ lane: voice, step });
      try {
        toggleGridStep(patternId, voice, step, stepsPerBar);
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [toggleGridStep, patternId],
  );
  const onSelect = useCallback((voice: string, step: number | undefined) => {
    setSelected({ lane: voice, step });
  }, []);
  /**
   * Commit a dragged velocity.
   *
   * The one interesting line is the `undefined`: a hit dragged back to exactly
   * what it was inheriting has stopped overriding anything, so the override is
   * removed rather than written as a number equal to the default. That is the
   * difference between a `stepEvents` array that says what the author meant and
   * one that grows an entry every time a cell is touched.
   */
  const onVelocity = useCallback(
    (voice: string, step: number, velocity: number, inherited: number) => {
      setSelected({ lane: voice, step });
      try {
        setStepEvent(patternId, voice, step, { velocity: velocity === inherited ? undefined : velocity });
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [setStepEvent, patternId],
  );

  const selectedLane = selected === undefined ? undefined : lanesByVoice.get(selected.lane);

  return (
    <div className="editor">
      <div className="editor-grid">
        <div className="lane-labels">
          <div className="ruler-label">bar</div>
          {rows.map((row) => (
            <button
              key={row.voice}
              type="button"
              className={`lane-label${row.lane === undefined ? " muted" : ""}${
                selected?.lane === row.voice ? " selected" : ""
              }`}
              onClick={() => onSelect(row.voice, undefined)}
              title={`select lane "${row.voice}" to edit its defaults, swing and grid`}
            >
              {row.voice}
              {row.lane !== undefined && <span className="muted"> ×{row.lane.grid.stepsPerBar}</span>}
            </button>
          ))}
        </div>
        <div className="lane-scroll">
          <div className="lane-stack" style={{ width: pattern.lengthTicks * geometry.pxPerTick }}>
            <Ruler bars={bars} beatsPerBar={geometry.beatsPerBar} beatPx={geometry.beatTicks * geometry.pxPerTick} />
            {rows.map((row) => (
              <LaneRow
                key={row.voice}
                voice={row.voice}
                lane={row.lane}
                bars={bars}
                barTicks={geometry.barTicks}
                beatTicks={geometry.beatTicks}
                pxPerTick={geometry.pxPerTick}
                patternId={patternId}
                projectSwing={projectSwing}
                selectedStep={selected?.lane === row.voice ? selected.step : undefined}
                onToggle={onToggle}
                onSelect={onSelect}
                onVelocity={onVelocity}
              />
            ))}
            <PatternPlayhead
              project={project}
              trackId={trackId}
              patternId={patternId}
              pxPerTick={geometry.pxPerTick}
            />
          </div>
        </div>
      </div>
      {selectedLane === undefined ? (
        <p className="muted">
          click a cell to toggle a hit; drag a hit up or down to set its velocity; shift-click one to edit its
          expression; click a lane name to edit the lane.
        </p>
      ) : (
        <>
          <LaneInspector
            project={project}
            patternId={patternId}
            lane={selectedLane}
            bars={bars}
            onError={setError}
            onClear={() => setSelected(undefined)}
          />
          {selected?.step !== undefined && (
            <StepInspector
              patternId={patternId}
              lane={selectedLane}
              step={selected.step}
              projectSwing={projectSwing}
              barTicks={geometry.barTicks}
              bars={bars}
              onClear={() => setSelected({ lane: selectedLane.lane, step: undefined })}
              onError={setError}
            />
          )}
        </>
      )}
      {error !== undefined && <p className="error">{error}</p>}
      {selectedLane === undefined && <SwingRefusalHint />}
    </div>
  );
}

/**
 * What is selected: a lane always, and a step within it when one was clicked.
 * A lane and a step are musical coordinates rather than array positions, so
 * unlike the piano roll's note index this selection survives an external edit
 * (PLAN.md §12 step 4).
 */
interface Selection {
  lane: string;
  step: number | undefined;
}

/** Bar and beat numbers above the cells, in the project's own meter. */
const Ruler = memo(function Ruler({
  bars,
  beatsPerBar,
  beatPx,
}: {
  bars: number;
  beatsPerBar: number;
  beatPx: number;
}): React.JSX.Element {
  const cells: React.JSX.Element[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      cells.push(
        <div
          key={`${bar}-${beat}`}
          className={beat === 0 ? "ruler-cell bar-start" : "ruler-cell"}
          style={{ width: beatPx }}
        >
          {beat === 0 ? bar + 1 : `.${beat + 1}`}
        </div>,
      );
    }
  }
  return <div className="ruler">{cells}</div>;
});

/** A press on a cell, until it is known whether it is a click or a velocity drag. */
interface CellPress {
  step: number;
  originY: number;
  from: number;
  inherited: number;
  velocity: number;
  dragging: boolean;
}

/**
 * One voice's row of cells.
 *
 * Memoized, with every prop either a primitive or stable by construction, because a
 * position report arrives about 47 times a second and moving the playhead must not
 * re-render every cell in the pattern.
 */
const LaneRow = memo(function LaneRow({
  voice,
  lane,
  bars,
  barTicks,
  beatTicks,
  pxPerTick,
  patternId,
  projectSwing,
  selectedStep,
  onToggle,
  onSelect,
  onVelocity,
}: {
  voice: string;
  lane: GridLane | undefined;
  bars: number;
  barTicks: number;
  beatTicks: number;
  pxPerTick: number;
  patternId: string;
  projectSwing: number;
  selectedStep: number | undefined;
  onToggle: (voice: string, step: number, stepsPerBar: number) => void;
  onSelect: (voice: string, step: number | undefined) => void;
  onVelocity: (voice: string, step: number, velocity: number, inherited: number) => void;
}): React.JSX.Element {
  const { shown: press, ref: pressRef, set: setPress } = useDragState<CellPress>();
  /** Set by a completed velocity drag, consumed by the `click` that follows it. */
  const draggedRef = useRef(false);

  // A voice with no lane yet still gets a full row of empty cells; clicking one
  // creates the lane at this resolution.
  const stepsPerBar = lane?.grid.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
  const total = stepsPerBar * bars;
  const stepTicks = barTicks / stepsPerBar;
  const context: LaneContext = { stepTicks, projectSwing };

  const parsed =
    lane === undefined
      ? undefined
      : parseSteps(lane.steps, { file: `patterns/${patternId}.json`, pointer: "", stepsPerBar, bars });
  if (parsed !== undefined && parsed.hits === undefined) {
    return (
      <div className="lane">
        <span className="error">
          lane &quot;{voice}&quot; does not parse:{" "}
          {parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}
        </span>
      </div>
    );
  }
  const hits = new Set(parsed?.hits ?? []);
  const overrides = new Map((lane?.stepEvents ?? []).map((event) => [event.step, event]));
  const swing = lane === undefined ? { permille: projectSwing } : laneSwing(lane, projectSwing);

  const cells: React.JSX.Element[] = [];
  for (let step = 0; step < total; step++) {
    const hit = hits.has(step);
    const override = overrides.get(step);
    const tickInBar = (step % stepsPerBar) * stepTicks;
    const classes = ["cell"];
    if (hit) classes.push("hit");
    if (tickInBar === 0) classes.push("bar-start");
    else if (tickInBar % beatTicks === 0) classes.push("beat-start");
    if (override !== undefined) classes.push("has-override");
    if (selectedStep === step) classes.push("selected");
    // A swung hit is marked, so "why did this one move and that one not" is
    // answered by looking rather than by counting step indices.
    if (hit && swing.permille > 0 && step % 2 === 1) classes.push("swung");
    if (press?.dragging === true && press.step === step) classes.push("dragging");

    const velocity =
      lane === undefined || !hit
        ? undefined
        : press?.step === step && press.dragging
          ? press.velocity
          : effectiveStepValue(lane, step, "velocity", context);
    const title = cellTitle(voice, step, hit, override, velocity);

    cells.push(
      <button
        key={step}
        type="button"
        className={classes.join(" ")}
        style={{
          width: stepTicks * pxPerTick,
          ...(velocity === undefined
            ? {}
            : // The filled portion is the velocity. A gradient rather than a child
              // element so a lane of 64 cells is 64 nodes, not 128.
              {
                background: `linear-gradient(to top, var(--hit) ${
                  expressionFraction("velocity", velocity) * 100
                }%, var(--hit-dim) 0)`,
              }),
        }}
        title={title}
        aria-label={title}
        aria-pressed={hit}
        onPointerDown={(event) => {
          if (lane === undefined || !hit || event.shiftKey) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setPress({
            step,
            originY: event.clientY,
            from: effectiveStepValue(lane, step, "velocity", context),
            inherited: inheritedStepValue(lane, "velocity", context),
            velocity: effectiveStepValue(lane, step, "velocity", context),
            dragging: false,
          });
        }}
        onPointerMove={(event) => {
          // `pressRef`, never `press`: see `useDragState`.
          const active = pressRef.current;
          if (active?.step !== step) return;
          const deltaY = event.clientY - active.originY;
          if (!active.dragging && Math.abs(deltaY) < DRAG_THRESHOLD_PX) return;
          const next = draggedVelocity(active.from, deltaY);
          if (active.dragging && next === active.velocity) return;
          setPress({ ...active, dragging: true, velocity: next });
        }}
        onPointerUp={() => {
          const finished = pressRef.current;
          setPress(undefined);
          if (finished?.step !== step || !finished.dragging) return;
          // The browser fires `click` after `pointerup`, and that click must not
          // also toggle the hit off. A ref rather than the cleared press state,
          // because whether React has re-rendered in between is not something to
          // depend on.
          draggedRef.current = true;
          onVelocity(voice, step, finished.velocity, finished.inherited);
        }}
        onPointerCancel={() => setPress(undefined)}
        onClick={(event) => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          // Shift-click selects without toggling, so the overrides of a hit can be
          // inspected and edited without the click that would turn it off.
          if (event.shiftKey) onSelect(voice, step);
          else onToggle(voice, step, stepsPerBar);
        }}
      >
        {override === undefined ? "" : "•"}
      </button>,
    );
  }
  return <div className="lane">{cells}</div>;
});

/** Resolution a new lane is created at: sixteenths of a 4/4 bar. */
const DEFAULT_STEPS_PER_BAR = 16;

function cellTitle(
  voice: string,
  step: number,
  hit: boolean,
  override: StepEvent | undefined,
  velocity: number | undefined,
): string {
  const what = `${voice} step ${step}${hit ? "" : " (rest)"}`;
  const level = velocity === undefined ? "" : ` — velocity ${velocity}`;
  if (override === undefined) return `${what}${level}`;
  return `${what}${level}. Overrides ${describeOverrides(override)}. Shift-click to edit; clicking it off discards them.`;
}

function describeOverrides(event: StepEvent): string {
  return describeFields(event, ["step"]);
}

function describeFields(source: object, skip: readonly string[]): string {
  return (
    Object.entries(source)
      .filter(([key]) => !skip.includes(key))
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(", ") || "none"
  );
}

/**
 * The lane itself: the expression every hit inherits, its swing, and its grid.
 *
 * The swing line is the reason this panel exists at all. Swing is the one
 * setting whose effect depends on *where the hits are* — only odd-indexed steps
 * move — so a control with a number next to it is not enough: it has to say how
 * many of this lane's own hits it is moving, or a kick on 0/4/8/12 reads as a
 * broken slider (docs/format-spec.md §4).
 */
function LaneInspector({
  project,
  patternId,
  lane,
  bars,
  onError,
  onClear,
}: {
  project: Project;
  patternId: string;
  lane: GridLane;
  bars: number;
  onError: (message: string | undefined) => void;
  onClear: () => void;
}): React.JSX.Element {
  const setLaneDefaults = useStore(documentStore, (state) => state.setLaneDefaults);
  const setLaneStepsPerBar = useStore(documentStore, (state) => state.setLaneStepsPerBar);

  const barTicks = ticksPerBar(project.project.ppqn, project.project.meterMap[0]!.timeSignature);
  const stepTicks = barTicks / lane.grid.stepsPerBar;
  const context: LaneContext = { stepTicks, projectSwing: project.project.swing };
  const parsed = parseSteps(lane.steps, {
    file: `patterns/${patternId}.json`,
    pointer: "",
    stepsPerBar: lane.grid.stepsPerBar,
    bars,
  });
  const swing = laneSwing(lane, project.project.swing);
  const effect = swingEffect(parsed.hits ?? [], swing.permille, stepTicks);
  const laneName = lane.lane;

  function apply(patch: LaneDefaultsPatch): void {
    try {
      setLaneDefaults(patternId, laneName, patch);
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>lane {laneName}</strong>
        <span className="muted">
          {effect.total} hits, {stepTicks} ticks per step
        </span>
        <button type="button" onClick={onClear}>
          close
        </button>
      </div>
      <div className="fields">
        <label>
          steps per bar
          <DraftField
            kind="number"
            label={`lane ${laneName} steps per bar`}
            value={String(lane.grid.stepsPerBar)}
            onCommit={(text) => {
              if (text.trim() === "") return;
              try {
                setLaneStepsPerBar(patternId, laneName, Number(text));
                onError(undefined);
              } catch (cause) {
                onError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          />
          <span className="muted">must divide a bar&rsquo;s {barTicks} ticks</span>
        </label>
        {LANE_DEFAULT_FIELDS.map((field) => (
          <label key={field}>
            {field}
            <DraftField
              kind="number"
              label={`lane ${laneName} default ${field}`}
              value={lane.defaults?.[field] === undefined ? "" : String(lane.defaults[field])}
              placeholder={laneDefaultPlaceholder(field, context)}
              onCommit={(text) => {
                const value = text.trim() === "" ? undefined : Number(text);
                if (value !== undefined && !Number.isFinite(value)) {
                  onError(`"${text}" is not a number`);
                  return;
                }
                apply({ [field]: value } as LaneDefaultsPatch);
              }}
            />
            <span className="muted">{fieldCaption(field)}</span>
          </label>
        ))}
      </div>
      <p className="muted">
        swing {swing.permille} permille ({swing.from}) delays every odd-indexed step by {effect.delayTicks} ticks —{" "}
        <strong>
          {effect.moved} of {effect.total} hits in this lane move
        </strong>
        {effect.moved === 0 && effect.total > 0 && " , because every hit here is on an even step"}.
      </p>
    </div>
  );
}

/** What a lane default falls back to when the lane does not set it. */
function laneDefaultPlaceholder(field: LaneDefaultField, context: LaneContext): string {
  const value = formatDefault(field, context);
  if (field === "swing") return `${value} (project)`;
  if (field === "gateTicks") return `${value} (one step)`;
  return String(value);
}

/**
 * The selected step's expression, and the lane defaults it overrides.
 *
 * Each box shows what the step inherits as its placeholder, so an empty field reads
 * as "inherits 800" rather than "no velocity" — the difference between the document
 * the file holds and one a UI can imply.
 */
function StepInspector({
  patternId,
  lane,
  step,
  projectSwing,
  barTicks,
  bars,
  onClear,
  onError,
}: {
  patternId: string;
  lane: GridLane;
  step: number;
  projectSwing: number;
  barTicks: number;
  bars: number;
  onClear: () => void;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const setStepEvent = useStore(documentStore, (state) => state.setStepEvent);

  const parsed = parseSteps(lane.steps, {
    file: `patterns/${patternId}.json`,
    pointer: "",
    stepsPerBar: lane.grid.stepsPerBar,
    bars,
  });
  const isHit = parsed.hits?.includes(step) ?? false;
  const event = lane.stepEvents?.find((entry) => entry.step === step);
  const laneName = lane.lane;
  const context: LaneContext = { stepTicks: barTicks / lane.grid.stepsPerBar, projectSwing };

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>
          {laneName} step {step}
        </strong>
        <span className="muted">
          {isHit ? "hit" : "rest — a rest cannot carry overrides"}
          {isHit && event !== undefined && "; empty a box to drop that override"}
        </span>
        {event !== undefined && (
          <button
            type="button"
            onClick={() => {
              try {
                // Every field at once, each removed rather than written back as
                // the value it was inheriting: what is left is a step that says
                // nothing, which is a step with no `stepEvents` entry at all.
                setStepEvent(
                  patternId,
                  laneName,
                  step,
                  Object.fromEntries(STEP_EVENT_FIELDS.map((field) => [field, undefined])) as StepEventPatch,
                );
                onError(undefined);
              } catch (cause) {
                onError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          >
            clear overrides
          </button>
        )}
        <button type="button" onClick={onClear}>
          close
        </button>
      </div>
      {isHit && (
        <div className="fields">
          {STEP_EVENT_FIELDS.map((field) => (
            <label key={field}>
              {field}
              <DraftField
                kind="number"
                label={`${laneName} step ${step} ${field}`}
                value={event?.[field] === undefined ? "" : String(event[field])}
                placeholder={String(inheritedStepValue(lane, field, context))}
                onCommit={(text) => {
                  try {
                    const value = text.trim() === "" ? undefined : Number(text);
                    if (value !== undefined && !Number.isFinite(value)) {
                      throw new Error(`"${text}" is not a number`);
                    }
                    setStepEvent(patternId, laneName, step, { [field]: value } as StepEventPatch);
                    onError(undefined);
                  } catch (cause) {
                    onError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              />
              <span className="muted">{fieldCaption(field)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A field's unit and range, plus the one thing about `gateTicks` a musician
 * cannot discover by turning it.
 *
 * A grid pattern only ever plays a drumkit in v1, and a drumkit hit is
 * `{offset, voice, velocity}` — `DrumkitTrackRunner.collect` never reads the
 * event's duration, so the sample plays out however long the gate says. The gate
 * is not dead, though: `emitRatchets` divides it into the ratchet's repeats, so
 * it is exactly what sets how far apart a ratchet's hits land. Saying so is the
 * difference between a control that looks broken and one that has a use.
 */
function fieldCaption(field: StepEventField | LaneDefaultField): string {
  const range = describeExpressionRange(field);
  return field === "gateTicks" ? `${range} — spaces a ratchet; a drum hit plays out regardless` : range;
}

/** The one thing about swing that cannot be discovered by turning the knob. */
function SwingRefusalHint(): React.JSX.Element {
  return (
    <p className="muted">
      swing only delays odd-indexed steps, so a hit on every fourth step never moves. select a lane to see how many
      of its hits swing actually reaches.
    </p>
  );
}
