// `worklet.ts` is deliberately absent: importing it calls `registerProcessor`,
// which only exists inside an AudioWorkletGlobalScope. Bundle that file directly
// for `addModule`; everything it needs is exported here.
export { liveGraph, requiredSamplePaths, type LiveGraph } from "./configure.js";
export { LiveEngine, type LiveEngineOptions } from "./engine.js";
export {
  DEFAULT_LOOKAHEAD_SECONDS,
  DEFAULT_TICK_INTERVAL_MS,
  LiveTransport,
  intervalTicker,
  lookaheadSamples,
  type AudioClock,
  type CommandSink,
  type LiveTransportOptions,
  type Ticker,
} from "./host.js";
export {
  LIVE_PROCESSOR_NAME,
  assertNever,
  type LiveCommand,
  type LiveEvent,
  type LivePosition,
  type LiveSampleRef,
  type LiveSliceTrack,
  type LiveTrackConfig,
} from "./protocol.js";
export { hashContent, SampleStore } from "./sampleCache.js";
export { LiveSession, type LiveSessionOptions, type SampleFetcher } from "./session.js";
export { LiveScheduler, nextBarBoundary, type SliceAction, type StructuralChange } from "./scheduler.js";
export { ScheduleSlicer, firstEventAtOrAfter, type ScheduleSlice } from "./slicer.js";
