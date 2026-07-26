const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Lowest representable pitch, `C-1` (format-spec §5.1). */
export const LOWEST_MIDI = 0;
/** Highest representable pitch, `G9`. */
export const HIGHEST_MIDI = 127;

/**
 * The names `midiToPitch` writes, one per pitch class. Sharps, because the
 * format accepts both spellings and something has to be chosen; a caller that
 * wants flats is editing an existing name, not naming a bare MIDI number, and
 * `fmt` keeps whichever spelling is already in the file.
 */
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

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
  const match = /^([A-G])(#|b)?(-1|[0-9])$/.exec(pitch);
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
  return `${SHARP_NAMES[midi % 12]!}${Math.floor(midi / 12) - 1}`;
}
