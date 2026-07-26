import {
  HIGHEST_MIDI,
  LOWEST_MIDI,
  midiToPitch,
  pitchToMidi,
  transposePitch,
  type NoteEvent,
  type NotesPatternDoc,
} from "@chord-garden/format/pure";
import { snapNearest } from "./grid";

/**
 * The piano roll's arithmetic: pixels to a note, and a drag to a change.
 *
 * Pure and separate from the component because this is where a piano roll is
 * silently wrong. A row-to-pitch conversion an octave out, a drag that quantises a
 * note nobody asked it to, an edit that drops `microTicks` on the way through — none
 * of those look wrong on screen, and none are reachable by a test that has to render
 * React and synthesise pointer events first.
 */

export interface RollGeometry {
  pxPerTick: number;
  rowPx: number;
  /** MIDI number of the top row; rows descend by a semitone each.  */
  highestMidi: number;
}

export interface Placement {
  pitch: string;
  startTick: number;
}

/**
 * The note a click at an offset inside the canvas places.
 *
 * The start is snapped to the grid absolutely — a brand-new note has no off-grid
 * position to preserve — and the row is turned into a pitch by the format package's
 * `midiToPitch`, never by arithmetic here.
 */
export function placementAt(offsetX: number, offsetY: number, geometry: RollGeometry, snapTicks: number): Placement {
  const tick = snapNearest(offsetX / geometry.pxPerTick, snapTicks);
  const midi = clampMidi(geometry.highestMidi - Math.floor(offsetY / geometry.rowPx));
  return { pitch: midiToPitch(midi), startTick: tick };
}

/** Top edge of the row a pitch sits on, in pixels from the top of the canvas. */
export function rowTop(midi: number, geometry: RollGeometry): number {
  return (geometry.highestMidi - midi) * geometry.rowPx;
}

/**
 * What moving a note by `deltaTicks` and `deltaRows` changes, or `undefined` when it
 * changes nothing — a click that only selected the note, or a drag too short to cross
 * a grid line.
 *
 * The delta is already snapped by the caller, and it is the *delta* that is snapped,
 * not the result: a note deliberately placed 8 ticks behind the beat stays 8 ticks
 * behind it after being dragged a bar to the right. Only `startTick` and `pitch` are
 * returned, so velocity, `microTicks`, `probability` and `ratchet` are carried by the
 * note they belong to rather than re-stated here, where one forgotten field would
 * quietly erase them.
 *
 * The pitch moves through `transposePitch`, which keeps the note's own accidental,
 * for the same reason the tick delta is snapped rather than the tick: an accidental
 * the author wrote is not the drag's to change. Every keyboard and pointer move in
 * the roll goes through here, so there is one place that has to be right.
 */
export function movedNote(
  note: NoteEvent,
  deltaTicks: number,
  deltaRows: number,
  pattern: NotesPatternDoc,
): Partial<NoteEvent> | undefined {
  const startTick = Math.max(0, Math.min(note.startTick + deltaTicks, pattern.lengthTicks - 1));
  // A pitch outside the grammar has no row, so vertical movement is not defined for
  // it; the horizontal move is still honest and is the only way to fix the note in
  // the UI at all.
  const pitch = transposePitch(note.pitch, deltaRows) ?? note.pitch;
  if (startTick === note.startTick && pitch === note.pitch) return undefined;
  return { startTick, pitch };
}

/** What resizing a note by `deltaTicks` changes, clamped to at least `minTicks`. */
export function resizedNote(note: NoteEvent, deltaTicks: number, minTicks: number): Partial<NoteEvent> | undefined {
  const durationTicks = Math.max(minTicks, note.durationTicks + deltaTicks);
  if (durationTicks === note.durationTicks) return undefined;
  return { durationTicks };
}

/**
 * The pitch rows to draw: every pitch the pattern uses, with an octave of headroom
 * either side so there is somewhere to drag to, clamped to the representable range.
 * An empty pattern opens around middle C, which is where a person starts looking.
 */
export function pitchRange(pattern: NotesPatternDoc): PitchRange {
  const used = pattern.notes
    .map((note) => pitchToMidi(note.pitch))
    .filter((midi): midi is number => midi !== undefined);
  if (used.length === 0) return { low: 48, high: 72 };
  return {
    low: Math.max(LOWEST_MIDI, Math.min(...used) - 12),
    high: Math.min(HIGHEST_MIDI, Math.max(...used) + 12),
  };
}

export interface PitchRange {
  low: number;
  high: number;
}

/**
 * The wider of two ranges, field by field.
 *
 * The roll's visible range only ever grows while a pattern is open. Recomputing it
 * from the notes on every edit means the canvas resizes and the rows shift under the
 * pointer as soon as you drag a note up an octave or delete the highest one — which
 * moves the thing you are about to click next. Growing only is the cheapest fix that
 * does not need a scroll position to be preserved.
 */
export function widerOf(left: PitchRange, right: PitchRange): PitchRange {
  return { low: Math.min(left.low, right.low), high: Math.max(left.high, right.high) };
}

function clampMidi(midi: number): number {
  return Math.max(LOWEST_MIDI, Math.min(HIGHEST_MIDI, midi));
}

/** The five semitones drawn as black keys, for any octave. */
export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

/** Fields a note may carry beyond the four every note has. */
export function hasExpression(note: NoteEvent): boolean {
  return note.microTicks !== undefined || note.probability !== undefined || note.ratchet !== undefined;
}
