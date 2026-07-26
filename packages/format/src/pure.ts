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
export { parseStrictJson, type JsonObject, type JsonValue, type ParseResult } from "./jsonParse.js";
export * from "./model.js";
export { ticksPerBar, type TimeSignature } from "./musicTime.js";
export { formatSteps, parseSteps, type StepsContext, type StepsParseResult } from "./pattern.js";
export { pitchToMidi } from "./pitch.js";
export {
  BASIC_MONO_PARAMS,
  BASIC_POLY_PARAMS,
  DRUMKIT_VOICE_PARAMS,
  checkParamValue,
  resolveParam,
  validParamKeys,
  type ParamSpec,
  type ParamUnit,
  type ResolvedParam,
} from "./registry.js";
export { serializeCanonical, type DocKind } from "./serialize.js";
export { closestMatch, levenshtein, ID_PATTERN } from "./util.js";
export { checkWavHeader, type WavCheckResult } from "./wav.js";
