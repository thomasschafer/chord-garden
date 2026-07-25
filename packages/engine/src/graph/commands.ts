import type { CompiledNoteEvent } from "../compiler.js";
import type { NoteCommand } from "../dsp/index.js";

/**
 * Total order on the note-on/note-off stream a synth track feeds its processor.
 *
 * The order is load-bearing rather than cosmetic: a note-off is delivered before
 * a note-on at the same sample so a zero-length note cannot silence the voice
 * that follows it, and ties break on note id so the stream is a function of the
 * schedule alone. The live path merges its stream incrementally and the offline
 * path sorts one array, so this comparator is the single definition both obey.
 */
export const NOTE_OFF_RANK = 0;
export const NOTE_ON_RANK = 1;

export function noteCommandRank(kind: NoteCommand["kind"]): number {
  return kind === "off" ? NOTE_OFF_RANK : NOTE_ON_RANK;
}

export function compareNoteCommandOrder(
  sampleLeft: number,
  rankLeft: number,
  noteIdLeft: number,
  sampleRight: number,
  rankRight: number,
  noteIdRight: number,
): number {
  if (sampleLeft !== sampleRight) return sampleLeft - sampleRight;
  if (rankLeft !== rankRight) return rankLeft - rankRight;
  return noteIdLeft - noteIdRight;
}

export interface TimedNoteCommand {
  /** Absolute sample position in the compiled schedule. */
  sample: number;
  kind: NoteCommand["kind"];
  noteId: number;
  midi: number;
  velocity: number;
}

/**
 * The whole command stream for a track's events, in `compareNoteCommandOrder`.
 *
 * This is the specification of what the live engine's incremental merge must
 * produce; tests pin the two against each other. Note ids are positions in
 * `events`, so the same schedule always yields the same ids.
 */
export function expandNoteCommands(events: readonly CompiledNoteEvent[], firstNoteId = 0): TimedNoteCommand[] {
  const commands: TimedNoteCommand[] = [];
  events.forEach((event, index) => {
    const noteId = firstNoteId + index;
    commands.push({ sample: event.startSample, kind: "on", noteId, midi: event.midi, velocity: event.velocity });
    commands.push({
      sample: event.startSample + event.durationSamples,
      kind: "off",
      noteId,
      midi: event.midi,
      velocity: event.velocity,
    });
  });
  commands.sort((left, right) =>
    compareNoteCommandOrder(
      left.sample,
      noteCommandRank(left.kind),
      left.noteId,
      right.sample,
      noteCommandRank(right.kind),
      right.noteId,
    ),
  );
  return commands;
}
