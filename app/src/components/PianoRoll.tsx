import { midiToPitch, pitchToMidi, type NoteEvent, type NotesPatternDoc, type Project } from "@chord-garden/format/pure";
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { documentStore } from "../session";
import type { NotePatch, OptionalNoteField, RequiredNoteField } from "../store/documentStore";
import { defaultSnapTicks, gridGeometry, ROW_PX, snapNearest, snapOptions } from "../view/grid";
import {
  hasExpression,
  isBlackKey,
  movedNote,
  pitchRange,
  placementAt,
  resizedNote,
  rowTop,
  widerOf,
  type PitchRange,
  type RollGeometry,
} from "../view/roll";
import { DraftField } from "./DraftField";
import { PatternPlayhead } from "./Playhead";

/**
 * A piano roll for one note pattern: notes placed by `startTick` and pitch, with a
 * length, added by clicking, moved and resized by dragging.
 *
 * Three decisions worth stating.
 *
 * **Pitch is a name, converted in one place.** Rows are MIDI numbers because a grid
 * needs a row index, and the only conversion between a row and a `pitch` is the
 * format package's `midiToPitch`/`pitchToMidi`. docs/format-spec.md §5.1 spends a
 * paragraph on the octave convention precisely because a private conversion that is
 * an octave out writes valid documents that sound wrong. Moving an existing note
 * goes through `transposePitch` instead, which keeps the accidental the author
 * wrote; the roll names a pitch from scratch only when placing a new note.
 *
 * **The grid is a view, and snapping is relative.** Positions in the document are
 * integer ticks (PLAN.md §6); the 16th-note grid is what gets drawn. A drag moves a
 * note by whole grid units and keeps whatever sub-grid offset it already had, so
 * dragging a note that was deliberately 8 ticks late does not silently straighten
 * it — and a note nobody touched is never rewritten at all.
 *
 * **`microTicks`, `probability` and `ratchet` are visible.** They ride along
 * untouched through a move or a resize, they are marked on the note, and they are
 * editable in the inspector. A roll that dropped them on the first drag would be
 * the quiet data loss this whole format is arranged to prevent.
 */
export function PianoRoll({
  project,
  trackId,
  pattern,
}: {
  project: Project;
  /** The track that plays this pattern; the playhead is only defined through it. */
  trackId: string;
  pattern: NotesPatternDoc;
}): React.JSX.Element {
  const addNote = useStore(documentStore, (state) => state.addNote);
  const updateNote = useStore(documentStore, (state) => state.updateNote);
  const deleteNote = useStore(documentStore, (state) => state.deleteNote);

  const [snapTicks, setSnapTicks] = useState(() => defaultSnapTicks(project));
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const rangeRef = useRef<{ patternId: string; range: PitchRange } | undefined>(undefined);

  /**
   * The rows on show, widened but never narrowed for as long as this pattern is open.
   * Held in a ref rather than state because it is derived from the document and must
   * be up to date in the same render that added the note — a state update would draw
   * one frame with the new note clipped off the top.
   */
  function visibleRange(target: NotesPatternDoc): PitchRange {
    const needed = pitchRange(target);
    const held = rangeRef.current;
    const next = held?.patternId === target.id ? widerOf(held.range, needed) : needed;
    rangeRef.current = { patternId: target.id, range: next };
    return next;
  }

  const geometry = gridGeometry(project);
  const range = visibleRange(pattern);
  const roll: RollGeometry = { pxPerTick: geometry.pxPerTick, rowPx: ROW_PX, highestMidi: range.high };
  // Stable while the range is, so the memo on `Rows` bails out on a playhead tick.
  const rows = useMemo(() => {
    const list: number[] = [];
    for (let midi = range.high; midi >= range.low; midi--) list.push(midi);
    return list;
  }, [range.high, range.low]);
  const canvasWidth = pattern.lengthTicks * geometry.pxPerTick;

  function attempt(action: () => void): void {
    try {
      action();
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function beginDrag(index: number, mode: DragMode, event: ReactPointerEvent<HTMLElement>): void {
    const note = pattern.notes[index];
    if (note === undefined) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(index);
    setDrag({ index, mode, originX: event.clientX, originY: event.clientY, note, deltaTicks: 0, deltaRows: 0 });
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>): void {
    if (drag === undefined) return;
    const ticks = snapNearest(Math.abs(event.clientX - drag.originX) / geometry.pxPerTick, snapTicks);
    const signedTicks = event.clientX < drag.originX ? -ticks : ticks;
    const rowsMoved = drag.mode === "move" ? -Math.round((event.clientY - drag.originY) / ROW_PX) : 0;
    if (signedTicks === drag.deltaTicks && rowsMoved === drag.deltaRows) return;
    setDrag({ ...drag, deltaTicks: signedTicks, deltaRows: rowsMoved });
  }

  /** The change the drag in progress would make, for both the preview and the commit. */
  function pendingChange(current: Drag): Partial<NoteEvent> | undefined {
    return current.mode === "resize"
      ? resizedNote(current.note, current.deltaTicks, snapTicks)
      : movedNote(current.note, current.deltaTicks, current.deltaRows, pattern);
  }

  function endDrag(): void {
    if (drag === undefined) return;
    const next = pendingChange(drag);
    setDrag(undefined);
    if (next === undefined) return;
    attempt(() => updateNote(pattern.id, drag.index, next));
  }

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <label>
          snap
          <select
            value={snapTicks}
            onChange={(event) => setSnapTicks(Number(event.target.value))}
          >
            {snapOptions(project).map((option) => (
              <option key={option.label} value={option.ticks}>
                {option.label} ({option.ticks} ticks)
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          click empty space to add a note · drag to move · drag the right edge to resize · Delete removes
        </span>
      </div>
      <div className="editor-grid">
        <div className="keys">
          {rows.map((midi) => (
            <div key={midi} className={isBlackKey(midi) ? "key black" : "key"}>
              {midi % 12 === 0 || rows.length <= 14 ? midiToPitch(midi) : ""}
            </div>
          ))}
        </div>
        <div className="lane-scroll">
          <div
            className="roll-canvas"
            style={{
              width: canvasWidth,
              height: rows.length * ROW_PX,
              backgroundSize: `${geometry.beatTicks * geometry.pxPerTick}px ${ROW_PX * 12}px`,
            }}
            onClick={(event) => {
              // A click, not a pointerdown, and only the first of a double-click:
              // `pointerdown` fires once per click of a double-click, so adding on it
              // put two or three notes down for one impatient hand. `detail` is the
              // click index the browser already tracks.
              if (event.detail > 1) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const placement = placementAt(event.clientX - bounds.left, event.clientY - bounds.top, roll, snapTicks);
              if (placement.startTick >= pattern.lengthTicks) return;
              attempt(() => {
                addNote(pattern.id, {
                  ...placement,
                  durationTicks: Math.min(snapTicks, pattern.lengthTicks - placement.startTick),
                  velocity: DEFAULT_VELOCITY,
                });
                setSelected(pattern.notes.length);
              });
            }}
          >
            <Rows rows={rows} />
            <BarLines
              bars={pattern.lengthTicks / geometry.barTicks}
              barPx={geometry.barTicks * geometry.pxPerTick}
              height={rows.length * ROW_PX}
            />
            {pattern.notes.map((note, index) => {
              const shown = drag?.index === index ? { ...note, ...(pendingChange(drag) ?? {}) } : note;
              const midi = pitchToMidi(shown.pitch);
              if (midi === undefined) {
                // A pitch the grammar rejects cannot be placed on a row. The
                // document is invalid and says so through diagnostics; drawing
                // nothing here is better than guessing a row.
                return null;
              }
              const top = rowTop(midi, roll);
              return (
                <button
                  key={index}
                  type="button"
                  className={`note${selected === index ? " selected" : ""}${hasExpression(note) ? " expressive" : ""}`}
                  style={{
                    left: shown.startTick * geometry.pxPerTick,
                    top,
                    width: Math.max(3, shown.durationTicks * geometry.pxPerTick),
                    height: ROW_PX - 1,
                  }}
                  title={describeNote(note)}
                  aria-label={describeNote(note)}
                  onPointerDown={(event) => beginDrag(index, "move", event)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => setDrag(undefined)}
                  // `click` bubbles even though `pointerdown` was stopped, and the
                  // canvas behind this note adds a note when clicked.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      setSelected(undefined);
                      attempt(() => deleteNote(pattern.id, index));
                      return;
                    }
                    const step = event.key === "ArrowLeft" ? -snapTicks : event.key === "ArrowRight" ? snapTicks : 0;
                    const semitone = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
                    if (step === 0 && semitone === 0) return;
                    event.preventDefault();
                    // The same `movedNote` a drag commits, so the keyboard cannot
                    // acquire its own idea of a move — of the clamping at the edges
                    // of the pattern and the keyboard, or of the note's spelling.
                    const change = movedNote(note, step, semitone, pattern);
                    if (change === undefined) return;
                    attempt(() => updateNote(pattern.id, index, change));
                  }}
                  onFocus={() => setSelected(index)}
                >
                  <span className="note-label">{shown.pitch}</span>
                  <span
                    className="note-resize"
                    onPointerDown={(event) => beginDrag(index, "resize", event)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onClick={(event) => event.stopPropagation()}
                  />
                </button>
              );
            })}
            <PatternPlayhead
              project={project}
              trackId={trackId}
              patternId={pattern.id}
              pxPerTick={geometry.pxPerTick}
            />
          </div>
        </div>
      </div>
      <NoteInspector
        patternId={pattern.id}
        index={selected}
        note={selected === undefined ? undefined : pattern.notes[selected]}
        onDelete={() => {
          if (selected === undefined) return;
          setSelected(undefined);
          attempt(() => deleteNote(pattern.id, selected));
        }}
        onError={setError}
      />
      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}

/** Velocity a newly placed note gets: the same 800 the compiler uses for a grid hit. */
const DEFAULT_VELOCITY = 800;

type DragMode = "move" | "resize";

interface Drag {
  index: number;
  mode: DragMode;
  originX: number;
  originY: number;
  /** The note as it was when the drag began, so the preview is never cumulative. */
  note: NoteEvent;
  deltaTicks: number;
  deltaRows: number;
}

/** Everything the note holds, for its tooltip and its accessible name. */
function describeNote(note: NoteEvent): string {
  const parts = [note.pitch, `tick ${note.startTick}`, `${note.durationTicks} ticks`, `velocity ${note.velocity}`];
  if (note.microTicks !== undefined) parts.push(`microTicks ${note.microTicks}`);
  if (note.probability !== undefined) parts.push(`probability ${note.probability}`);
  if (note.ratchet !== undefined) parts.push(`ratchet ${note.ratchet}`);
  return parts.join(", ");
}

const Rows = memo(function Rows({ rows }: { rows: readonly number[] }): React.JSX.Element {
  return (
    <>
      {rows.map((midi) => (
        <div key={midi} className={isBlackKey(midi) ? "roll-row black" : "roll-row"} style={{ height: ROW_PX }} />
      ))}
    </>
  );
});

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
        <div key={bar} className="bar-line" style={{ left: bar * barPx, height }}>
          <span>{bar + 1}</span>
        </div>
      ))}
    </>
  );
});

/** Units, for the label beside each box; the format's, not a guess. */
const NOTE_FIELD_UNITS: Record<RequiredNoteField | OptionalNoteField, string> = {
  pitch: "C4 = MIDI 60",
  startTick: "ticks from pattern start",
  durationTicks: "ticks",
  velocity: "permille 0..1000",
  microTicks: "ticks, \u00b1",
  probability: "permille 0..1000",
  ratchet: "repeats \u2265 1",
};

/**
 * Every field of the selected note, including the optional ones it does not set.
 *
 * Required and optional fields are rendered from separate lists rather than one list
 * with a boolean, because that is what `NotePatch` distinguishes: only an optional
 * field can be cleared, and the two `apply` calls below are the only place that has
 * to be true.
 */
function NoteInspector({
  patternId,
  index,
  note,
  onDelete,
  onError,
}: {
  patternId: string;
  index: number | undefined;
  note: NoteEvent | undefined;
  onDelete: () => void;
  onError: (message: string | undefined) => void;
}): React.JSX.Element {
  const updateNote = useStore(documentStore, (state) => state.updateNote);

  if (index === undefined || note === undefined) {
    return <p className="muted">no note selected.</p>;
  }
  const at = index;

  function apply(changes: NotePatch): void {
    try {
      updateNote(patternId, at, changes);
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>note {index}</strong>{" "}
        <span className="muted">
          position in the in-memory list; <code>fmt</code> sorts the file by start, pitch, then length
        </span>{" "}
        <button type="button" onClick={onDelete}>
          delete
        </button>
      </div>
      <div className="fields">
        <label>
          pitch
          <DraftField
            label={`note ${index} pitch`}
            value={note.pitch}
            size={5}
            onCommit={(text) => apply({ pitch: text.trim() })}
          />
          <span className="muted">{NOTE_FIELD_UNITS.pitch}</span>
        </label>
        {(["startTick", "durationTicks", "velocity"] as const).map((field) => (
          <label key={field}>
            {field}
            <DraftField
              kind="number"
              label={`note ${index} ${field}`}
              value={String(note[field])}
              onCommit={(text) => {
                // A required field has no "unset", so an empty box is not an edit; the
                // store refuses anything else the format cannot hold.
                if (text.trim() === "") return;
                apply({ [field]: Number(text) });
              }}
            />
            <span className="muted">{NOTE_FIELD_UNITS[field]}</span>
          </label>
        ))}
        {(["microTicks", "probability", "ratchet"] as const).map((field) => (
          <label key={field}>
            {field}
            <DraftField
              kind="number"
              label={`note ${index} ${field}`}
              value={note[field] === undefined ? "" : String(note[field])}
              placeholder="unset"
              onCommit={(text) => {
                apply(text.trim() === "" ? { [field]: undefined } : { [field]: Number(text) });
              }}
            />
            <span className="muted">{NOTE_FIELD_UNITS[field]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
