/**
 * The slice of AudioWorkletGlobalScope this package uses.
 *
 * Hand-written rather than pulled in from `@types/audioworklet`: it is four
 * declarations, the package's `lib` is deliberately `ES2022` with no DOM (the
 * same code runs in Node for the offline renderer), and a types package that
 * expects DOM lib types would either drag them in or need `skipLibCheck` to be
 * covering for it. Four lines we can read beat a dependency we cannot.
 *
 * `port` is typed structurally instead of as `MessagePort` for the same reason —
 * `MessagePort` is a DOM type. The real `MessagePort` satisfies this shape.
 */
interface AudioWorkletPort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: AudioWorkletPort;
  constructor();
  /** Return true to keep the node alive; the transport outlives any one block. */
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorConstructor: new () => AudioWorkletProcessor,
): void;
