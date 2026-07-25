const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

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
