export {
  compile,
  musicalGrid,
  type CompileOptions,
  type CompiledAutomationLane,
  type CompiledNoteEvent,
  type CompiledSchedule,
  type CompiledTrack,
  type MusicalGrid,
} from "./compiler.js";
export * from "./dsp/index.js";
export {
  DEFAULT_RENDER_OPTIONS,
  render,
  type RenderOptions,
  type RenderedAudio,
  type StereoAudio,
} from "./render/renderer.js";
export {
  decodeWav,
  encodeWav,
  writeWav,
  type DecodedWav,
  type PcmBitDepth,
  type WavAudio,
} from "./render/wav.js";
