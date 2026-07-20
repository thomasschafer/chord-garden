import type { TimeSignature } from "./musicTime.js";

/**
 * Hand-written domain types for the on-disk documents. These are the public
 * contract; `test/schemaTypes.test.ts` proves they stay aligned with the JSON
 * Schemas by round-tripping the fixtures through both.
 */

export interface TempoPoint {
  startTick: number;
  /** bpm×100: 124 BPM is stored as 12400. */
  bpm: number;
}

export interface MeterPoint {
  startTick: number;
  timeSignature: TimeSignature;
}

export interface KeySignature {
  root: string;
  scale: "major" | "minor";
}

export interface ProjectDoc {
  format: number;
  name: string;
  description?: string;
  ppqn: number;
  tempoMap: TempoPoint[];
  meterMap: MeterPoint[];
  key?: KeySignature;
  swing: number;
  trackOrder: string[];
}

export type TrackType = "drumkit" | "instrument";

export interface TrackDoc {
  id: string;
  description?: string;
  type: TrackType;
  instrument: string;
  patterns: string[];
}

export type SynthEngine = "basic-mono" | "basic-poly";

export interface SynthInstrumentDoc {
  id: string;
  description?: string;
  type: "synth";
  engine: SynthEngine;
  params?: Record<string, number | string>;
}

export interface KitVoice {
  sample: string;
}

export interface DrumkitInstrumentDoc {
  id: string;
  description?: string;
  type: "drumkit";
  kit: Record<string, KitVoice>;
  params?: Record<string, number | string>;
}

export type InstrumentDoc = SynthInstrumentDoc | DrumkitInstrumentDoc;

export interface LaneDefaults {
  velocity?: number;
  gateTicks?: number;
  probability?: number;
  swing?: number;
}

export interface StepEvent {
  step: number;
  velocity?: number;
  microTicks?: number;
  gateTicks?: number;
  probability?: number;
  ratchet?: number;
}

export interface GridLane {
  lane: string;
  grid: { stepsPerBar: number };
  steps: string;
  defaults?: LaneDefaults;
  stepEvents?: StepEvent[];
}

export interface GridPatternDoc {
  id: string;
  description?: string;
  kind: "grid";
  lengthTicks: number;
  lanes: GridLane[];
}

export interface NoteEvent {
  pitch: string;
  startTick: number;
  durationTicks: number;
  velocity: number;
  microTicks?: number;
  probability?: number;
  ratchet?: number;
}

export interface NotesPatternDoc {
  id: string;
  description?: string;
  kind: "notes";
  lengthTicks: number;
  notes: NoteEvent[];
}

export type PatternDoc = GridPatternDoc | NotesPatternDoc;

export interface Clip {
  track: string;
  pattern: string;
  startTick: number;
  repeatCount: number;
}

export interface ArrangementDoc {
  description?: string;
  lengthTicks: number;
  clips: Clip[];
}

export type AutomationInterp = "linear" | "step";

export interface AutomationLane {
  param: string;
  interp: AutomationInterp;
  points: [number, number][];
}

export interface AutomationDoc {
  track: string;
  description?: string;
  lanes: AutomationLane[];
}

/** A fully loaded, validated project bundle. */
export interface Project {
  root: string;
  project: ProjectDoc;
  tracks: Map<string, TrackDoc>;
  instruments: Map<string, InstrumentDoc>;
  patterns: Map<string, PatternDoc>;
  arrangement: ArrangementDoc;
  automation: Map<string, AutomationDoc>;
}
