import {
  parseSteps,
  type DrumkitInstrumentDoc,
  type GridLane,
  type GridPatternDoc,
  type LaneDefaults,
  type Project,
  type StepEvent,
} from "@chord-garden/format/pure";
import { memo, useCallback, useState } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import type { StepEventPatch } from "../store/documentStore";
import { gridGeometry } from "../view/grid";
import { DraftField } from "./DraftField";
import { PatternPlayhead } from "./Playhead";

/**
 * A step sequencer for one grid pattern: a lane per kit voice, a cell per step.
 *
 * Two rules shape the whole file.
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
  const [selected, setSelected] = useState<{ lane: string; step: number } | undefined>(undefined);
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
  const onSelect = useCallback((voice: string, step: number) => {
    setSelected({ lane: voice, step });
  }, []);

  const selectedLane = selected === undefined ? undefined : lanesByVoice.get(selected.lane);

  return (
    <div className="editor">
      <div className="editor-grid">
        <div className="lane-labels">
          <div className="ruler-label">bar</div>
          {rows.map((row) => (
            <div key={row.voice} className={row.lane === undefined ? "lane-label muted" : "lane-label"}>
              {row.voice}
              {row.lane !== undefined && <span className="muted"> ×{row.lane.grid.stepsPerBar}</span>}
            </div>
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
                selectedStep={selected?.lane === row.voice ? selected.step : undefined}
                onToggle={onToggle}
                onSelect={onSelect}
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
      <StepInspector
        patternId={patternId}
        lane={selectedLane}
        step={selected?.step}
        projectSwing={project.project.swing}
        bars={bars}
        onClear={() => setSelected(undefined)}
        onError={setError}
      />
      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
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
  selectedStep,
  onToggle,
  onSelect,
}: {
  voice: string;
  lane: GridLane | undefined;
  bars: number;
  barTicks: number;
  beatTicks: number;
  pxPerTick: number;
  patternId: string;
  selectedStep: number | undefined;
  onToggle: (voice: string, step: number, stepsPerBar: number) => void;
  onSelect: (voice: string, step: number) => void;
}): React.JSX.Element {
  // A voice with no lane yet still gets a full row of empty cells; clicking one
  // creates the lane at this resolution.
  const stepsPerBar = lane?.grid.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
  const total = stepsPerBar * bars;
  const stepTicks = barTicks / stepsPerBar;

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
    const title = cellTitle(voice, step, hit, override);
    cells.push(
      <button
        key={step}
        type="button"
        className={classes.join(" ")}
        style={{ width: stepTicks * pxPerTick }}
        title={title}
        aria-label={title}
        aria-pressed={hit}
        onClick={(event) => {
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

function cellTitle(voice: string, step: number, hit: boolean, override: StepEvent | undefined): string {
  const what = `${voice} step ${step}${hit ? "" : " (rest)"}`;
  if (override === undefined) return what;
  return `${what} — overrides ${describeOverrides(override)}. Shift-click to edit; clicking it off discards them.`;
}

function describeOverrides(event: StepEvent): string {
  return describeFields(event, ["step"]);
}

/**
 * The lane's default expression. `swing` is reported separately, with where it came
 * from: it is the one `defaults` field that falls back to a project-level value
 * rather than to a fixed one (docs/format-spec.md §4).
 */
function describeDefaults(defaults: LaneDefaults | undefined): string {
  return defaults === undefined ? "none" : describeFields(defaults, ["swing"]);
}

function describeFields(source: object, skip: readonly string[]): string {
  return (
    Object.entries(source)
      .filter(([key]) => !skip.includes(key))
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(", ") || "none"
  );
}

const OVERRIDE_FIELDS: { field: keyof StepEventPatch; unit: string }[] = [
  { field: "velocity", unit: "permille 0..1000" },
  { field: "probability", unit: "permille 0..1000" },
  { field: "microTicks", unit: "ticks, ±" },
  { field: "gateTicks", unit: "ticks > 0" },
  { field: "ratchet", unit: "repeats ≥ 1" },
];

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
  bars,
  onClear,
  onError,
}: {
  patternId: string;
  lane: GridLane | undefined;
  step: number | undefined;
  projectSwing: number;
  bars: number;
  onClear: () => void;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const setStepEvent = useStore(documentStore, (state) => state.setStepEvent);

  if (lane === undefined || step === undefined) {
    return <p className="muted">click a cell to toggle a hit; shift-click one to edit its expression.</p>;
  }
  const parsed = parseSteps(lane.steps, {
    file: `patterns/${patternId}.json`,
    pointer: "",
    stepsPerBar: lane.grid.stepsPerBar,
    bars,
  });
  const isHit = parsed.hits?.includes(step) ?? false;
  const event = lane.stepEvents?.find((entry) => entry.step === step);
  const laneName = lane.lane;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>
          {laneName} step {step}
        </strong>{" "}
        <span className="muted">
          {isHit ? "hit" : "rest — a rest cannot carry overrides"}; lane defaults: {describeDefaults(lane.defaults)};
          swing {lane.defaults?.swing ?? projectSwing} permille (
          {lane.defaults?.swing === undefined ? "project" : "lane"})
        </span>{" "}
        <button type="button" onClick={onClear}>
          close
        </button>
      </div>
      {isHit && (
        <div className="fields">
          {OVERRIDE_FIELDS.map(({ field, unit }) => (
            <label key={field}>
              {field}
              <DraftField
                kind="number"
                label={`${laneName} step ${step} ${field}`}
                value={event?.[field] === undefined ? "" : String(event[field])}
                placeholder={placeholderFor(field, lane)}
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
              <span className="muted">{unit}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the step inherits when it overrides nothing, spelled out in the box. */
function placeholderFor(field: keyof StepEventPatch, lane: GridLane): string {
  if (field === "velocity") return String(lane.defaults?.velocity ?? 800);
  if (field === "probability") return String(lane.defaults?.probability ?? 1000);
  if (field === "gateTicks") return lane.defaults?.gateTicks === undefined ? "one step" : String(lane.defaults.gateTicks);
  if (field === "ratchet") return "1";
  return "0";
}
