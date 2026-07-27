import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type Project, type SynthInstrumentDoc } from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { compile, type CompiledSchedule } from "../src/compiler.js";
import { CONTROL_BLOCK_SIZE, db100ToGain } from "../src/index.js";
import { LIVE_PROCESSOR_NAME, type LiveEvent, type LivePosition } from "../src/live/protocol.js";
import { hashContent } from "../src/live/sampleCache.js";
import { createLiveRun, renderLive, type LiveRun } from "./live/liveRun.js";
import { createWorkletHarness } from "./live/workletHarness.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));

function loadedProject(root: string): Project {
  const loaded = loadProject(root);
  if (loaded.project === undefined) {
    throw new Error(`fixture ${root} did not load: ${loaded.diagnostics.map((each) => each.message).join("; ")}`);
  }
  return loaded.project;
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let highest = 0;
  for (let index = from; index < to; index++) highest = Math.max(highest, Math.abs(samples[index]!));
  return highest;
}

/** Same options `createLiveRun` compiles with, so schedules are comparable. */
function compileLive(project: Project): CompiledSchedule {
  return compile(project, { sampleRate: 48_000, seed: 0 });
}

/** One long sustaining note and nothing else, so a gain change is measurable. */
function sustainedSynthProject(gainDb100: number): Project {
  return {
    root: "",
    project: {
      format: 1,
      name: "live parameter test",
      ppqn: 480,
      tempoMap: [{ startTick: 0, bpm: 12_000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["synth"],
    },
    tracks: new Map([
      ["synth", { id: "synth", type: "instrument", instrument: "synth-main", patterns: ["notes"] }],
    ]),
    instruments: new Map([
      [
        "synth-main",
        {
          id: "synth-main",
          type: "synth",
          engine: "basic-mono",
          params: {
            oscillator: "sawtooth",
            "filter.cutoff": 2000,
            "filter.resonance": 100,
            "amp.attack": 5,
            "amp.decay": 0,
            "amp.sustain": 1000,
            "amp.release": 10,
            gain: gainDb100,
          },
        },
      ],
    ]),
    patterns: new Map([
      [
        "notes",
        {
          id: "notes",
          kind: "notes",
          lengthTicks: 1920,
          notes: [{ pitch: "A3", startTick: 0, durationTicks: 1920, velocity: 900 }],
        },
      ],
    ]),
    arrangement: { lengthTicks: 1920, clips: [{ track: "synth", pattern: "notes", startTick: 0, repeatCount: 1 }] },
    automation: new Map(),
  };
}

function reports(events: readonly LiveEvent[]): LivePosition[] {
  return events.filter((event): event is LivePosition => event.type === "position");
}

function errors(events: readonly LiveEvent[]): string[] {
  return events.flatMap((event) => (event.type === "error" ? [event.message] : []));
}

/** Blocks of live audio, appended to whatever the run has already produced. */
function renderBlocks(run: LiveRun, blocks: number): { left: Float32Array; right: Float32Array } {
  const result = renderLive(run, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
  return { left: result.left, right: result.right };
}

describe("live transport", () => {
  it("silences every voice on stop and leaves nothing ringing", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    run.transport.start();
    const sounding = renderBlocks(run, 16);
    expect(peak(sounding.left)).toBeGreaterThan(0.05);

    run.transport.stop();
    const afterStop = renderBlocks(run, 16);
    expect(peak(afterStop.left)).toBe(0);
    expect(peak(afterStop.right)).toBe(0);
    expect(reports(run.harness.events).at(-1)).toMatchObject({ playing: false, activeVoices: 0 });
  });

  /**
   * The failure this is here for: a seek that only moves the playhead leaves the
   * voices from the old position sounding over the new one, which is audible as a
   * note that never ends.
   */
  it("leaves no voice sounding after a seek", async () => {
    const project = loadedProject(FIXTURE);
    const run = await createLiveRun(project);
    run.transport.start();
    // Into the bass entry at bar 4, so a sustaining voice is genuinely open: a
    // drum hit between blocks would leave no voice for the seek to fail to stop.
    const before = renderBlocks(run, Math.ceil(run.barStarts[4]! / CONTROL_BLOCK_SIZE) + 40);
    expect(peak(before.left)).toBeGreaterThan(0.05);
    const voicesBefore = reports(run.harness.events).at(-1)?.activeVoices ?? 0;
    expect(voicesBefore).toBeGreaterThan(0);

    // Past the end of the arrangement there is nothing left to trigger, so any
    // sound at all after seeking there is a voice the seek failed to stop.
    const empty = run.schedule.totalSamples;
    run.transport.seek(empty);
    const quiet = renderBlocks(run, 8);
    expect(peak(quiet.left)).toBe(0);
    expect(peak(quiet.right)).toBe(0);
    expect(reports(run.harness.events).at(-1)).toMatchObject({ activeVoices: 0 });

    // And the seek did not simply mute the engine: seeking back into the
    // arrangement plays again.
    run.transport.seek(run.barStarts[15]!);
    const resumed = renderBlocks(run, 200);
    expect(peak(resumed.left)).toBeGreaterThan(0.05);
  });

  it("reports the position it is actually at, and the transport re-anchors to it", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    run.transport.start();
    renderBlocks(run, 40);
    const rendered = 40 * CONTROL_BLOCK_SIZE;
    expect(reports(run.harness.events).at(-1)?.positionSample).toBe(rendered);
    // The transport follows the reports, so it trails by at most one report
    // interval — and never leads, which would schedule a window twice.
    expect(run.transport.positionSample).toBeLessThanOrEqual(rendered);
    expect(run.transport.positionSample).toBeGreaterThanOrEqual(rendered - 8 * CONTROL_BLOCK_SIZE);
  });
});

describe("structural and parameter changes through the worklet", () => {
  function withDoubledSecondBar(project: Project): Project {
    return {
      ...project,
      arrangement: {
        ...project.arrangement,
        clips: [
          ...project.arrangement.clips,
          { track: "drums", pattern: "drums-verse", startTick: 3840, repeatCount: 1 },
        ],
      },
    };
  }

  function withBassGain(project: Project, gainDb100: number): Project {
    const bass = project.instruments.get("bass-synth");
    if (bass === undefined || bass.type !== "synth") throw new Error("fixture lost its bass synth");
    const replacement: SynthInstrumentDoc = { ...bass, params: { ...bass.params, gain: gainDb100 } };
    return { ...project, instruments: new Map(project.instruments).set("bass-synth", replacement) };
  }

  /**
   * PLAN.md §12 step 6: a structural change waits for a bar boundary. The audio
   * before the switch has to be untouched — that is the whole point of deferring —
   * so it is compared bit for bit against a run that never received the change.
   */
  it("applies a structural change at the bar boundary, quantised to a render quantum", async () => {
    const project = loadedProject(FIXTURE);
    const plain = await createLiveRun(project);
    plain.transport.start();
    const blocks = 1600;
    const untouched = renderLive(plain, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const changed = await createLiveRun(project);
    changed.transport.start();
    changed.transport.tick();
    const variant = loadedProject(FIXTURE);
    const variantSchedule = compileLive(withDoubledSecondBar(variant));
    const change = changed.transport.applyStructuralChange(variantSchedule, changed.barStarts);

    // The switch lands on the first render quantum at or after bar 1: a bar line
    // is a tick position and falls mid-block, and the DSP graph cannot be swapped
    // mid-block.
    const barLine = changed.barStarts[1]!;
    const switchBlock = Math.ceil(barLine / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
    expect(change.atSample).toBe(switchBlock);
    expect(switchBlock - barLine).toBeLessThan(CONTROL_BLOCK_SIZE);
    const configure = changed.posted.filter((command) => command.type === "configure").at(-1);
    expect(configure).toMatchObject({ type: "configure", generation: 1, atSample: switchBlock });

    const live = renderLive(changed, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    for (let index = 0; index < switchBlock; index++) {
      if (!Object.is(untouched.left[index], live.left[index])) {
        throw new Error(`structural change altered sample ${index} before the switch at ${switchBlock}`);
      }
    }
    let differs = false;
    for (let index = switchBlock; index < blocks * CONTROL_BLOCK_SIZE; index++) {
      if (!Object.is(untouched.left[index], live.left[index])) differs = true;
    }
    expect(differs).toBe(true);
    expect(reports(changed.harness.events).at(-1)?.generation).toBe(1);
    expect(errors(changed.harness.events)).toEqual([]);
  });

  /**
   * A parameter change must not restart a voice. Asserted by ratio rather than by
   * eye: dropping the gain by 6 dB scales the same waveform, whereas a restarted
   * voice would re-attack from zero and the ratio would collapse at the change.
   * A synth-only project is used so the ratio is the whole signal's — a coincident
   * drum hit would not scale and would swamp it.
   */
  it("applies a parameter change in place, without restarting a sounding voice", async () => {
    const before = 0;
    const after = -600;
    const settled = 40;

    const plain = await createLiveRun(sustainedSynthProject(before));
    plain.transport.start();
    const plainAudio = renderLive(plain, (settled + 40) * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const project = sustainedSynthProject(before);
    const tweaked = await createLiveRun(project);
    tweaked.transport.start();
    renderLive(tweaked, settled * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    const variant = sustainedSynthProject(after);
    // Recompiled, not the same object: the schedule-equality check that guards
    // against a misclassified structural edit has to be exercised for real.
    const recompiled = compileLive(variant);
    tweaked.transport.applyParameterChange(recompiled, [
      {
        trackIndex: 0,
        instrument: variant.instruments.get("synth-main")!,
        effects: [],
        automation: recompiled.tracks[0]!.automation,
      },
    ]);
    const afterChange = renderLive(tweaked, 40 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const expectedRatio = db100ToGain(after) / db100ToGain(before);
    const offset = settled * CONTROL_BLOCK_SIZE;
    let compared = 0;
    for (let index = 0; index < afterChange.left.length; index++) {
      const original = plainAudio.left[offset + index]!;
      if (Math.abs(original) < 0.02) continue;
      expect(afterChange.left[index]! / original).toBeCloseTo(expectedRatio, 4);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    expect(errors(tweaked.harness.events)).toEqual([]);
  });

  it("refuses an in-place update that the DSP fixed at construction", async () => {
    const project = loadedProject(FIXTURE);
    const run = await createLiveRun(project);
    const pad = project.instruments.get("pad-synth");
    if (pad === undefined || pad.type !== "synth") throw new Error("fixture lost its pad synth");
    run.harness.send({
      type: "params",
      generation: 0,
      trackIndex: 2,
      instrument: { ...pad, params: { ...pad.params, maxVoices: 4 } },
      effects: [],
      automation: [],
    });
    expect(errors(run.harness.events).at(-1)).toMatch(/maxVoices went from 16 to 4/);
  });
});

describe("live protocol failures", () => {
  it("fails loudly on an unknown message rather than ignoring it", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    run.harness.send({ type: "rewind" } as never);
    expect(errors(run.harness.events).at(-1)).toMatch(/unexpected .*rewind/);
    expect(run.harness.rethrown).toHaveLength(1);
  });

  it("rejects a configure naming sample content it has not been sent", async () => {
    const project = loadedProject(FIXTURE);
    const harness = await createWorkletHarness(LIVE_PROCESSOR_NAME);
    const drumkit = project.instruments.get("drumkit-main")!;
    harness.send({
      type: "configure",
      generation: 0,
      atSample: null,
      tracks: [{ trackId: "drums", instrument: drumkit, effects: [], automation: [] }],
      samples: [{ path: "samples/kick.wav", contentHash: "deadbeef" }],
    });
    expect(errors(harness.events).at(-1)).toMatch(/sample "samples\/kick.wav" has not been sent/);
  });

  it("rejects a configure carrying a stale content hash after the sample changed", async () => {
    const project = loadedProject(FIXTURE);
    const run = await createLiveRun(project);
    const staleHash = run.contentHashes.get("samples/kick.wav")!;
    const replacement = readFileSync(join(project.root, "samples/hat.wav"));
    run.sendSample("samples/kick.wav", replacement);
    expect(run.contentHashes.get("samples/kick.wav")).not.toBe(staleHash);

    run.harness.send({
      type: "configure",
      generation: 5,
      atSample: null,
      tracks: run.graphOf(run.schedule).tracks,
      samples: [{ path: "samples/kick.wav", contentHash: staleHash }],
    });
    expect(errors(run.harness.events).at(-1)).toMatch(/holds content .*, not /);
  });

  it("rejects a slice for a generation it knows nothing about", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    run.harness.send({ type: "slice", generation: 9, startSample: 0, endSample: 128, tracks: [] });
    expect(errors(run.harness.events).at(-1)).toMatch(/generation 9 is neither active \(0\) nor queued/);
  });

  it("rejects params for a generation that is not the active one", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    const pad = run.graphOf(run.schedule).tracks[2]!;
    run.harness.send({
      type: "params",
      generation: 4,
      trackIndex: 2,
      instrument: pad.instrument,
      effects: [],
      automation: [],
    });
    expect(errors(run.harness.events).at(-1)).toMatch(/generation 4 is not the active generation 0/);
  });

  it("refuses a mono output instead of folding the mix into one channel", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    expect(run.harness.renderRaw([[new Float32Array(CONTROL_BLOCK_SIZE)]])).toBe(false);
    expect(errors(run.harness.events).at(-1)).toMatch(/needs a stereo output, got 1 channel/);
  });

  it("refuses to seek while a structural change is still queued", async () => {
    const run = await createLiveRun(loadedProject(FIXTURE));
    run.harness.send({ type: "start" });
    run.harness.send({
      type: "configure",
      generation: 3,
      atSample: Math.ceil(run.barStarts[2]! / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE,
      tracks: run.graphOf(run.schedule).tracks,
      samples: run.graphOf(run.schedule).samples,
    });
    run.harness.send({ type: "seek", sample: 0 });
    expect(errors(run.harness.events).at(-1)).toMatch(/cannot seek with generation 3 queued/);
  });
});

describe("sample replacement", () => {
  it("plays the new content once it arrives, and reports a different content hash", async () => {
    const project = loadedProject(FIXTURE);
    const kick = readFileSync(join(project.root, "samples/kick.wav"));
    const hat = readFileSync(join(project.root, "samples/hat.wav"));
    expect(hashContent(kick)).not.toBe(hashContent(hat));

    const plain = await createLiveRun(project);
    plain.transport.start();
    const original = renderLive(plain, 64 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const swapped = await createLiveRun(project);
    swapped.sendSample("samples/kick.wav", hat);
    swapped.transport.start();
    const replaced = renderLive(swapped, 64 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    expect(peak(original.left)).toBeGreaterThan(0.05);
    expect(peak(replaced.left)).toBeGreaterThan(0);
    let differing = 0;
    for (let index = 0; index < original.left.length; index++) {
      if (!Object.is(original.left[index], replaced.left[index])) differing++;
    }
    expect(differing).toBeGreaterThan(100);
    expect(errors(swapped.harness.events)).toEqual([]);
  });
});

