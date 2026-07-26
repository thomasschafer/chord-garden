const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The grammar of a `pitch`, docs/format-spec.md §5.1, in one place. */
const PITCH_NAME = /^([A-G])(#|b)?(-1|[0-9])$/;

/** Lowest representable pitch, `C-1` (format-spec §5.1). */
export const LOWEST_MIDI = 0;
/** Highest representable pitch, `G9`. */
export const HIGHEST_MIDI = 127;

/**
 * The names `midiToPitch` writes, one per pitch class. Sharps, because the
 * format accepts both spellings and something has to be chosen; a caller that
 * wants flats is editing an existing name, not naming a bare MIDI number, and
 * that caller wants `transposePitch`.
 */
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/**
 * The same twelve pitch classes spelled with flats, for `transposePitch`.
 *
 * Only the five two-name classes differ. The seven naturals keep their letter —
 * no `Cb` or `Fb` — which is what keeps the octave arithmetic below identical for
 * both tables: every name here belongs to the same octave as its sharp twin.
 */
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/** Which of a pitch class's two names a spelling uses; naturals have only one. */
type AccidentalStyle = "sharp" | "flat";

/**
 * Scientific pitch notation to a MIDI note number, or undefined if the spelling
 * is not one this format accepts.
 *
 * Lives in its own module rather than beside the validation that first needed it
 * because the event compiler needs it too, and the compiler has to be reachable
 * from a browser bundle: `semantic.ts` reads the filesystem, so importing pitch
 * parsing from there would drag `node:fs` into the web app (see `pure.ts`).
 */
export function pitchToMidi(pitch: string): number | undefined {
  const match = PITCH_NAME.exec(pitch);
  if (!match) return undefined;
  const base = PITCH_CLASS[match[1]!]!;
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const octave = Number(match[3]);
  return base + accidental + (octave + 1) * 12;
}

/**
 * A MIDI note number as a note name this format accepts — the inverse of
 * `pitchToMidi`, and the only way anything should turn a number back into a
 * `pitch`.
 *
 * It lives here rather than in the editor that first wanted it because a second
 * implementation of the octave convention is precisely the bug docs/format-spec.md
 * §5.1 spends a paragraph warning about: an editor one octave out writes valid
 * documents that sound wrong, and nothing downstream can tell.
 *
 * Throws outside 0..127 rather than returning a name the validator would reject
 * as `note.pitch-out-of-range`. A caller placing a note knows its own row range;
 * one that does not has a bug worth hearing about at the point it happens.
 */
export function midiToPitch(midi: number): string {
  if (!Number.isInteger(midi) || midi < LOWEST_MIDI || midi > HIGHEST_MIDI) {
    throw new Error(`cannot name MIDI note ${midi}: the representable range is ${LOWEST_MIDI}..${HIGHEST_MIDI} (C-1..G9)`);
  }
  return nameFor(midi, "sharp");
}

/**
 * The pitch `semitones` away from `pitch`, spelled the way `pitch` already is, or
 * `undefined` if `pitch` is not a name this format accepts.
 *
 * This, and not `pitchToMidi` followed by `midiToPitch`, is how an editor moves a
 * note up or down. The round trip through a number is spelling-blind — it names
 * MIDI 34 `A#1` whatever it was called before — so an editor that used it turned
 * every `Bb` in the file into an `A#` the moment the note was dragged. That is
 * inaudible and enharmonically identical, and it is still an edit nobody asked
 * for: the accidental is the author's, and `fmt` is careful to keep whichever
 * they wrote (docs/format-spec.md §5.1).
 *
 * Preserving the *existing* accidental is the whole rule. There is deliberately
 * no notion of the project's key here: A minor has no flats to infer from, and a
 * speller that guesses at musical intent would respell notes for its own reasons,
 * which is the thing being fixed rather than a better version of it.
 *
 * The result is clamped to the representable range, so dragging a note off either
 * end of the keyboard stops there rather than naming something no document can
 * hold. A move of zero semitones returns the name unchanged, which keeps a purely
 * horizontal drag from rewriting an out-of-range pitch that `validate` is already
 * complaining about.
 */
export function transposePitch(pitch: string, semitones: number): string | undefined {
  const midi = pitchToMidi(pitch);
  if (midi === undefined) return undefined;
  if (semitones === 0) return pitch;
  const moved = Math.max(LOWEST_MIDI, Math.min(HIGHEST_MIDI, midi + semitones));
  return nameFor(moved, accidentalStyle(pitch));
}

/** The accidental a name already uses; naturals have none, so they get sharps. */
function accidentalStyle(pitch: string): AccidentalStyle {
  return PITCH_NAME.exec(pitch)?.[2] === "b" ? "flat" : "sharp";
}

/** A representable MIDI number as a name, in one of the two spellings. */
function nameFor(midi: number, style: AccidentalStyle): string {
  const names = style === "flat" ? FLAT_NAMES : SHARP_NAMES;
  return `${names[midi % 12]!}${Math.floor(midi / 12) - 1}`;
}
