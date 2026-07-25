import type { JsonValue } from "./jsonParse.js";
import type { Clip, NoteEvent, Project } from "./model.js";
import { ticksPerBar } from "./musicTime.js";
import { formatSteps, parseSteps } from "./pattern.js";
import { pitchToMidi } from "./pitch.js";
import { serializeCanonical } from "./serialize.js";

/**
 * Canonical bytes for every file of a valid project. This is the single
 * source of truth `fmt` writes and round-trip/byte-stability tests assert on.
 * Callers must only pass fully validated projects.
 */
export function canonicalFiles(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  const barTicks = ticksPerBar(project.project.ppqn, project.project.meterMap[0]!.timeSignature);

  out.set("project.json", serializeCanonical(clone(project.project), "project"));

  for (const track of project.tracks.values()) {
    out.set(`tracks/${track.id}.json`, serializeCanonical(clone(track), "track"));
  }

  for (const instrument of project.instruments.values()) {
    const kind = instrument.type === "synth" ? "instrument.synth" : "instrument.drumkit";
    out.set(`instruments/${instrument.id}.json`, serializeCanonical(clone(instrument), kind));
  }

  for (const pattern of project.patterns.values()) {
    const path = `patterns/${pattern.id}.json`;
    if (pattern.kind === "notes") {
      const doc = structuredClone(pattern);
      doc.notes.sort(compareNotes);
      out.set(path, serializeCanonical(clone(doc), "pattern.notes"));
      continue;
    }
    const doc = structuredClone(pattern);
    const bars = doc.lengthTicks / barTicks;
    for (const lane of doc.lanes) {
      const parsed = parseSteps(lane.steps, {
        file: path,
        pointer: "",
        stepsPerBar: lane.grid.stepsPerBar,
        bars,
      });
      if (parsed.hits === undefined) {
        throw new Error(`canonicalFiles called with invalid steps string in ${path}, lane "${lane.lane}"`);
      }
      lane.steps = formatSteps(parsed.hits, lane.grid.stepsPerBar, bars);
      lane.stepEvents?.sort((a, b) => a.step - b.step);
    }
    out.set(path, serializeCanonical(clone(doc), "pattern.grid"));
  }

  const arrangement = structuredClone(project.arrangement);
  arrangement.clips.sort(compareClips);
  out.set("arrangement.json", serializeCanonical(clone(arrangement), "arrangement"));

  for (const automation of project.automation.values()) {
    out.set(`automation/${automation.track}.json`, serializeCanonical(clone(automation), "automation"));
  }

  return out;
}

function compareNotes(a: NoteEvent, b: NoteEvent): number {
  if (a.startTick !== b.startTick) return a.startTick - b.startTick;
  const midiA = pitchToMidi(a.pitch) ?? 0;
  const midiB = pitchToMidi(b.pitch) ?? 0;
  if (midiA !== midiB) return midiA - midiB;
  return a.durationTicks - b.durationTicks;
}

function compareClips(a: Clip, b: Clip): number {
  if (a.startTick !== b.startTick) return a.startTick - b.startTick;
  return a.track < b.track ? -1 : a.track > b.track ? 1 : 0;
}

/**
 * Documents are plain parsed-JSON objects; this cast makes that explicit at
 * the single place the typed model re-enters the generic serializer.
 */
function clone(doc: unknown): JsonValue {
  return doc as JsonValue;
}
