import { CONTROL_BLOCK_SIZE } from "../../src/dsp/index.js";
import type { LiveCommand, LiveEvent } from "../../src/live/protocol.js";

/**
 * A test double for the AudioWorklet globals, so `src/live/worklet.ts` — the real
 * file, not a copy of it — can be driven in Node.
 *
 * What it does simulate:
 * - The true 128-sample render quantum, taken from `CONTROL_BLOCK_SIZE` rather
 *   than a number chosen here, and stereo `outputs[0]` of two separate channels.
 * - `registerProcessor`, including the fact that the module registers on import
 *   and the class is only reachable through the registry.
 * - Structured cloning in both directions, via Node's `structuredClone`. This is
 *   the part worth having: a message carrying something un-cloneable, or code that
 *   relies on sharing an object with the main thread, fails here the same way it
 *   would in a browser.
 * - `port.onmessage` delivery strictly between quanta, which is where the real
 *   worklet dispatches messages.
 *
 * What it does not simulate, and what therefore stays unproven until a browser:
 * - A second thread. Everything runs on one stack, so no race, no interleaving of
 *   a message with a half-finished block, and no GC pause is reachable.
 * - Real-time deadlines. A block that takes 10 ms produces no glitch here; only a
 *   browser can show whether the DSP keeps up.
 * - `AudioContext` behaviour around it: output latency, device sample rate,
 *   suspended contexts, the autoplay gesture requirement, and `addModule`'s
 *   requirement that the module be bundled with no bare specifiers left.
 * - Allocation behaviour. The hot path's freedom from allocation is argued from
 *   the code and cannot be asserted from here.
 */
export interface WorkletHarness {
  /** Deliver one command, as `port.onmessage` would between quanta. */
  send(command: LiveCommand): void;
  /** Render one quantum into `left`/`right`; returns what `process` returned. */
  render(left: Float32Array, right: Float32Array): boolean;
  /** `process` with arbitrary outputs, for asserting on a non-stereo output. */
  renderRaw(outputs: Float32Array[][]): boolean;
  /** Everything the processor has posted back, cloned. */
  readonly events: LiveEvent[];
  /** Errors `handle` rethrew after posting them, in order. */
  readonly rethrown: unknown[];
  readonly quantumSize: number;
}

interface Port {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface ProcessorLike {
  readonly port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

type ProcessorConstructor = new () => ProcessorLike;

const registry = new Map<string, ProcessorConstructor>();
let installed: Promise<void> | undefined;

/**
 * Install the globals and import the worklet module once per process, the way a
 * browser loads it once per `addModule`.
 */
async function installGlobals(): Promise<void> {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.sampleRate = 48_000;
  scope.AudioWorkletProcessor = class {
    readonly port: Port;
    constructor() {
      const posted: LiveEvent[] = [];
      this.port = {
        postMessage(message: unknown) {
          posted.push(structuredClone(message) as LiveEvent);
        },
        onmessage: null,
      };
      (this as unknown as { posted: LiveEvent[] }).posted = posted;
    }
  };
  scope.registerProcessor = (name: string, constructor: ProcessorConstructor) => {
    registry.set(name, constructor);
  };
  await import("../../src/live/worklet.js");
}

/**
 * Instantiate the processor the worklet module registered under `name`. The
 * harness's own sample rate is fixed at 48 kHz because the module reads the
 * `sampleRate` global at construction, exactly as it does in a browser.
 */
export async function createWorkletHarness(name: string): Promise<WorkletHarness> {
  installed ??= installGlobals();
  await installed;
  const constructor = registry.get(name);
  if (constructor === undefined) {
    throw new Error(`worklet module registered [${[...registry.keys()].join(", ")}], not "${name}"`);
  }
  const processor = new constructor();
  const events = (processor as unknown as { posted: LiveEvent[] }).posted;
  const rethrown: unknown[] = [];

  return {
    events,
    rethrown,
    quantumSize: CONTROL_BLOCK_SIZE,
    send(command) {
      const handler = processor.port.onmessage;
      if (handler === null) throw new Error("worklet installed no message handler");
      try {
        handler({ data: structuredClone(command) });
      } catch (error) {
        rethrown.push(error);
      }
    },
    render(left, right) {
      if (left.length !== CONTROL_BLOCK_SIZE || right.length !== CONTROL_BLOCK_SIZE) {
        throw new Error(`a render quantum is ${CONTROL_BLOCK_SIZE} frames, got ${left.length}`);
      }
      return processor.process([], [[left, right]], {});
    },
    renderRaw(outputs) {
      return processor.process([], outputs, {});
    },
  };
}
