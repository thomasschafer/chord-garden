import { LiveEngine } from "./engine.js";
import { LIVE_PROCESSOR_NAME, type LiveCommand } from "./protocol.js";

/**
 * The AudioWorklet entry point. Everything it does is hand the render quantum to
 * `LiveEngine`, which is the same code the offline renderer's DSP runs under, and
 * hand messages the other way; there is deliberately no audio logic here, because
 * this is the one file that cannot be exercised in Node.
 *
 * Constraints this file exists inside: no `node:*`, no DOM, no `fetch`, no dynamic
 * `import`. Bundle it to one self-contained module for `addModule` — the static
 * imports above must be inlined, not left as bare specifiers.
 */
class ChordGardenLiveProcessor extends AudioWorkletProcessor {
  private readonly engine: LiveEngine;

  constructor() {
    super();
    this.engine = new LiveEngine({
      sampleRate,
      post: (event) => {
        this.port.postMessage(event);
      },
    });
    this.port.onmessage = (event) => {
      try {
        this.engine.handle(event.data as LiveCommand);
      } catch (error) {
        // A throw here would be swallowed by the message dispatch, so the reason
        // is posted to the main thread before it is rethrown.
        this.port.postMessage({ type: "error", message: describe(error) });
        throw error;
      }
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1];
    if (left === undefined || right === undefined) {
      // Refuse rather than fold to mono: writing the mix twice into one channel
      // would double it, which is a wrong level rather than an obvious failure.
      this.port.postMessage({
        type: "error",
        message: `live worklet needs a stereo output, got ${String(output?.length)} channel(s)`,
      });
      return false;
    }
    try {
      this.engine.process(left, right);
    } catch (error) {
      this.port.postMessage({ type: "error", message: describe(error) });
      return false;
    }
    return true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerProcessor(LIVE_PROCESSOR_NAME, ChordGardenLiveProcessor);
