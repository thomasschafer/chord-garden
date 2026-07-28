import { parseWavHeader } from "@chord-garden/format/pure";

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

/**
 * Decode a PCM WAV to float channels.
 *
 * Every structural check lives in `parseWavHeader`, which `validate` also calls:
 * this function is the sample-reading half and nothing more. The two used to
 * carry separate, unequal copies of the rules, so the validator accepted files
 * the renderer could not read — and, for `sampleRate: 0`, files it read wrongly
 * without complaining.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const parsed = parseWavHeader(bytes);
  if (!parsed.ok) throw new Error(`cannot decode WAV: ${parsed.reason}`);
  const { sampleRate, channels, bitsPerSample, blockAlign, dataOffset, dataSize } = parsed.header;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const frames = dataSize / blockAlign;
  const left = new Float32Array(frames);
  const right = channels === 2 ? new Float32Array(frames) : undefined;
  const bytesPerSample = bitsPerSample / 8;
  for (let frame = 0; frame < frames; frame++) {
    const frameOffset = dataOffset + frame * blockAlign;
    left[frame] = decodePcm(view, frameOffset, bitsPerSample);
    if (right !== undefined) {
      right[frame] = decodePcm(view, frameOffset + bytesPerSample, bitsPerSample);
    }
  }

  return {
    sampleRate,
    bitsPerSample,
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

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
}
