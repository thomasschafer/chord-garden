/**
 * The subset of this package that a browser bundle can import.
 *
 * The package root re-exports `loadProject`, `semanticValidate` and
 * `schemaValidate`, all of which read the filesystem, so importing it from the
 * web app makes the bundle unresolvable — an error that only appears at bundle
 * time and is confusing when it does. Everything here is free of `node:*`, and
 * of anything else that is not plain computation over already-parsed documents.
 *
 * `./registry` stays a separate, narrower entry: the AudioWorklet reaches that
 * one, and a worklet cannot afford even the JSON parser.
 */
export { assembleProject, type AssembledFile } from "./assemble.js";
export { canonicalFiles } from "./canonical.js";
export { docKindFromHint, docKindHintForPath, type DocKindHint } from "./docKind.js";
export { describeProject, type DescribePattern, type DescribeReport, type DescribeTrack } from "./describe.js";
export {
  DiagnosticCollector,
  escapePointerSegment,
  joinPointer,
  type Diagnostic,
  type Loc,
  type Severity,
  type Span,
} from "./diagnostics.js";
export {
  EXPRESSION_FIELDS,
  LANE_DEFAULT_FIELDS,
  NOTE_EXPRESSION_FIELDS,
  STEP_EVENT_FIELDS,
  checkExpressionValue,
  describeExpressionRange,
  type ExpressionField,
  type ExpressionSpec,
  type ExpressionUnit,
  type LaneDefaultField,
  type NoteExpressionField,
  type StepEventField,
} from "./expression.js";
export { parseStrictJson, type JsonObject, type JsonValue, type ParseResult } from "./jsonParse.js";
export * from "./model.js";
export { gridStepOffsetTicks, swingOffsetTicks, ticksPerBar, type TimeSignature } from "./musicTime.js";
export { formatSteps, parseSteps, type StepsContext, type StepsParseResult } from "./pattern.js";
export { HIGHEST_MIDI, LOWEST_MIDI, midiToPitch, pitchToMidi, transposePitch } from "./pitch.js";
export {
  BASIC_MONO_PARAMS,
  BASIC_POLY_PARAMS,
  DELAY_PARAMS,
  DRUMKIT_VOICE_PARAMS,
  EFFECT_PARAMS,
  EFFECT_PARAM_PREFIX,
  EFFECT_TYPES,
  FILTER_EFFECT_PARAMS,
  PARAM_UNIT_LABELS,
  REVERB_PARAMS,
  automatableParams,
  automatableTrackParams,
  checkParamValue,
  describeParamRange,
  effectParamKey,
  effectParams,
  effectiveEffectParamValue,
  effectiveParamValue,
  instrumentParams,
  parseEffectParamKey,
  resolveEffectParam,
  resolveParam,
  resolveTrackParam,
  staticParamValue,
  staticTrackParamValue,
  validEffectParamKeys,
  validParamKeys,
  validTrackParamKeys,
  type AutomatableParam,
  type InstrumentParam,
  type ParamSpec,
  type ParamUnit,
  type ResolvedParam,
  type ResolvedTrackParam,
} from "./registry.js";
export { referencedSamplePaths, sampleReferences, type SampleReference } from "./samples.js";
export { serializeCanonical, type DocKind } from "./serialize.js";
export { closestMatch, levenshtein, ID_PATTERN } from "./util.js";
export { EFFECTS_MIN_FORMAT, SUPPORTED_FORMAT } from "./formatVersion.js";
export {
  checkWavHeader,
  parseWavHeader,
  type WavCheckResult,
  type WavHeader,
  type WavHeaderResult,
} from "./wav.js";
