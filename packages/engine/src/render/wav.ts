import { writeFileSync } from "node:fs";
import type { RenderedAudio } from "./renderer.js";

export interface DecodedWav {
  sampleRate: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  channels: [Float32Array] | [Float32Array, Float32Array];
}

export interface WavAudio {
  sampleRate: number;
  left: Float32Array;
  right?: Float32Array;
}

export type PcmBitDepth = 16 | 24;

export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("cannot decode WAV: expected a RIFF/WAVE container");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format:
    | { channels: 1 | 2; sampleRate: number; bitsPerSample: 8 | 16 | 24 | 32; blockAlign: number }
    | undefined;
  let dataOffset = -1;
  let dataSize = 0;

  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const chunk = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) throw new Error(`cannot decode WAV: truncated "${chunk}" chunk`);
    if (chunk === "fmt ") {
      if (size < 16) throw new Error("cannot decode WAV: fmt chunk is too small");
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1) throw new Error(`cannot decode WAV: unsupported audio format ${audioFormat}`);
      if (channels !== 1 && channels !== 2) throw new Error(`cannot decode WAV: unsupported channel count ${channels}`);
      if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
        throw new Error(`cannot decode WAV: unsupported PCM depth ${bitsPerSample}`);
      }
      format = { channels, sampleRate, blockAlign, bitsPerSample };
    } else if (chunk === "data" && dataOffset < 0) {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (format === undefined) throw new Error("cannot decode WAV: missing fmt chunk");
  if (dataOffset < 0) throw new Error("cannot decode WAV: missing data chunk");
  if (format.blockAlign === 0 || dataSize % format.blockAlign !== 0) {
    throw new Error("cannot decode WAV: data size is not aligned to PCM frames");
  }

  const frames = dataSize / format.blockAlign;
  const left = new Float32Array(frames);
  const right = format.channels === 2 ? new Float32Array(frames) : undefined;
  const bytesPerSample = format.bitsPerSample / 8;
  for (let frame = 0; frame < frames; frame++) {
    const frameOffset = dataOffset + frame * format.blockAlign;
    left[frame] = decodePcm(view, frameOffset, format.bitsPerSample);
    if (right !== undefined) {
      right[frame] = decodePcm(view, frameOffset + bytesPerSample, format.bitsPerSample);
    }
  }

  return {
    sampleRate: format.sampleRate,
    bitsPerSample: format.bitsPerSample,
    channels: right === undefined ? [left] : [left, right],
  };
}

export function encodeWav(audio: WavAudio, bitsPerSample: PcmBitDepth = 24): Uint8Array {
  const channels = audio.right === undefined ? 1 : 2;
  if (audio.right !== undefined && audio.right.length !== audio.left.length) {
    throw new Error("cannot encode WAV: left and right channel lengths differ");
  }
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = audio.left.length * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < audio.left.length; frame++) {
    offset = writePcm(view, offset, audio.left[frame]!, bitsPerSample);
    if (audio.right !== undefined) offset = writePcm(view, offset, audio.right[frame]!, bitsPerSample);
  }
  return bytes;
}

export function writeWav(
  path: string,
  audio: WavAudio | RenderedAudio,
  bitsPerSample: PcmBitDepth = 24,
): void {
  const source: WavAudio =
    "master" in audio
      ? { sampleRate: audio.sampleRate, left: audio.master.left, right: audio.master.right }
      : audio;
  writeFileSync(path, encodeWav(source, bitsPerSample));
}

function decodePcm(view: DataView, offset: number, bits: 8 | 16 | 24 | 32): number {
  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32768;
    case 24: {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if ((value & 0x800000) !== 0) value |= 0xff000000;
      return value / 8388608;
    }
    case 32:
      return view.getInt32(offset, true) / 2147483648;
  }
}

function writePcm(view: DataView, offset: number, sample: number, bits: PcmBitDepth): number {
  const clamped = Math.min(Math.max(sample, -1), 1);
  if (bits === 16) {
    const value = Math.min(Math.round(clamped * 32768), 32767);
    view.setInt16(offset, value, true);
    return offset + 2;
  }
  const value = Math.min(Math.round(clamped * 8388608), 8388607);
  view.setUint8(offset, value & 0xff);
  view.setUint8(offset + 1, (value >> 8) & 0xff);
  view.setUint8(offset + 2, (value >> 16) & 0xff);
  return offset + 3;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index++) value += String.fromCharCode(bytes[offset + index]!);
  return value;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
}
