import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "@chord-garden/cli";
import { canonicalFiles, loadProject, serializeCanonical } from "@chord-garden/format";
import { createAssetServer } from "@chord-garden/dev-server";
import { TOKEN_HEADER, WRITE_CONFLICT_STATUS } from "@chord-garden/dev-server/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentStore,
  hashText,
  WriteConflictError,
  type DocumentSink,
  type DocumentStore,
  type PendingDelete,
  type PendingFile,
} from "../src/store/documentStore";
import { FIXTURE, REPO_ROOT, openedFrom } from "./fixture";

/**
 * The invariant that makes the UI "one editor among two" (PLAN.md §3): a project
 * edited in the app and a project run through `musictool fmt` are byte-identical.
 *
 * Everything real: a temp copy of the fixture, the actual dev server with its
 * actual write endpoint, the actual store, and the actual CLI. The only stand-in
 * is the browser itself — the sink below sends the request a browser would,
 * including the `Origin` header the browser attaches and this test cannot get
 * `fetch` to attach.
 */

const TOKEN = "byte-identity-token-0123456789";

let server: Server;
let port: number;
let root: string;
let store: DocumentStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "chord-garden-identity-"));
  cpSync(FIXTURE, root, { recursive: true });
  server = createAssetServer({
    projects: [{ name: "p", root }],
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot: join(REPO_ROOT, "tools/dev-server/build"),
    token: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  store = createDocumentStore({ sink: httpSink() });
  store.getState().open(openedFrom(root));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  rmSync(root, { recursive: true, force: true });
});

/**
 * Posts a write batch the way the app's `ProjectClient` does, plus the `Origin`
 * header a browser attaches and `fetch` will not let a test set.
 *
 * The 409 translation mirrors `app/src/session.ts`: turning a transport status
 * into the store's own conflict type is a boundary concern, and each transport
 * does it for itself. The shared constant keeps the status from being written
 * down twice, and the tests below assert the raw status as well as the effect,
 * so a drift in this mapping cannot hide a drift in the server.
 */
function httpSink(): DocumentSink {
  return {
    async write(files: readonly PendingFile[], deletes: readonly PendingDelete[]) {
      const response = await post("/api/projects/p/write", JSON.stringify({ files, deletes }));
      if (response.status === WRITE_CONFLICT_STATUS) {
        throw new WriteConflictError(response.body, [...files, ...deletes].map((file) => file.path));
      }
      if (response.status !== 200) throw new Error(`write failed: ${response.status} ${response.body}`);
      return { diagnostics: [] };
    },
  };
}

function post(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [TOKEN_HEADER]: TOKEN,
          origin: `http://127.0.0.1:${port}`,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    call.on("error", reject);
    call.write(body);
    call.end();
  });
}

/** `musictool fmt --check`: exit 0 and "already canonical" means fmt agrees. */
function fmtCheck(): { code: number; stdout: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: { write: (value) => (stdout += value) }, stderr: { write: (value) => (stderr += value) } };
  const code = runCli(["fmt", root, "--check"], io);
  return { code, stdout: stdout + stderr };
}

/**
 * The lines that differ between two versions of one file, positionally.
 *
 * Deliberately naive — same line count or it throws — because that *is* the
 * assertion: an edit that adds or removes a line of a document it was only
 * supposed to change a value in has already failed, and a diff algorithm clever
 * enough to align around it would hide that.
 */
function diffLines(before: string, after: string): { before: string; after: string }[] {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length !== right.length) {
    throw new Error(`the file went from ${left.length} lines to ${right.length}; this edit should not resize it`);
  }
  return left
    .map((line, index) => ({ before: line, after: right[index]! }))
    .filter((pair) => pair.before !== pair.after);
}

/** Every document's bytes on disk right now. */
function onDisk(): Map<string, string> {
  const result = loadProject(root);
  if (result.project === undefined) throw new Error(`project stopped loading: ${JSON.stringify(result.diagnostics)}`);
  const bytes = new Map<string, string>();
  for (const path of result.files.keys()) bytes.set(path, readFileSync(join(root, path), "utf8"));
  return bytes;
}

describe("a UI edit is byte-identical to what the CLI would write", () => {
  it("leaves the project already canonical after a project-level edit", async () => {
    store.getState().setProjectName("Edited in the UI");
    store.getState().setTempoBpmX100(13_000);
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    // Stated the other way round too, so a change in `fmt`'s reporting cannot
    // quietly weaken this: the bytes on disk are what `canonicalFiles` produces
    // for the project those bytes parse back into.
    const reloaded = loadProject(root);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    expect(reloaded.project!.project.name).toBe("Edited in the UI");
    expect(reloaded.project!.project.tempoMap[0]!.bpm).toBe(13_000);
  });

  it("leaves the project already canonical after a pattern edit", async () => {
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x... x... x... x...");
    await store.getState().flushNow();

    expect(fmtCheck().stdout).toBe("already canonical\n");
    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    const pattern = reloaded.project!.patterns.get("drums-verse")!;
    expect(pattern.kind === "grid" && pattern.lanes[0]!.steps).toBe("x... x... x... x...");
  });

  /**
   * The grid editor's version of the same guarantee. Worth its own case because a
   * `steps` string is the one field whose canonical form `fmt` computes from the
   * project (grouping depends on `stepsPerBar` and the pattern's bar count), so it is
   * the field a UI is most likely to write in a form the CLI would rewrite — and the
   * write endpoint's canonical check cannot catch it, because that check sees one
   * document with no project around it.
   */
  it("leaves the project already canonical after toggling grid steps", async () => {
    store.getState().toggleGridStep("drums-verse", "hat", 5, 16);
    store.getState().toggleGridStep("drums-verse", "kick", 8, 16);
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    const pattern = reloaded.project!.patterns.get("drums-verse")!;
    if (pattern.kind !== "grid") throw new Error("the pattern stopped being a grid");
    expect(pattern.lanes.find((lane) => lane.lane === "hat")!.steps).toBe("x.x. xxx. x.x. x.x.");
    // The lane's other content came back exactly as it went in.
    expect(pattern.lanes.find((lane) => lane.lane === "hat")!.stepEvents).toEqual([
      { step: 2, velocity: 350, probability: 800 },
      { step: 8, microTicks: -12, gateTicks: 120, ratchet: 2 },
    ]);
  });

  it("leaves the project already canonical after adding, moving, resizing and deleting notes", async () => {
    store.getState().addNote("bass-main", { pitch: "F#2", startTick: 5760, durationTicks: 480, velocity: 640 });
    store.getState().updateNote("bass-main", 0, { startTick: 3360, pitch: "Eb2" });
    store.getState().updateNote("bass-main", 2, { durationTicks: 1200 });
    store.getState().deleteNote("bass-main", 1);
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    const pattern = reloaded.project!.patterns.get("bass-main")!;
    if (pattern.kind !== "notes") throw new Error("the pattern stopped being a note list");
    // Canonical order is start, then pitch as a MIDI number, then length — and the
    // flat spelling the edit asked for survived, because `fmt` never respells.
    expect(pattern.notes).toEqual([
      { pitch: "C2", startTick: 2400, durationTicks: 1200, velocity: 800, probability: 800 },
      { pitch: "Eb2", startTick: 3360, durationTicks: 720, velocity: 900 },
      { pitch: "F#2", startTick: 5760, durationTicks: 480, velocity: 640 },
    ]);
  });

  /**
   * The expression half of stage 1. Worth its own case because a `stepEvents`
   * entry is the densest thing in the format — five optional fields, sparse by
   * design, sorted by `fmt` — and the failure mode a UI reaches for is writing
   * back every field of the entry it touched, with the inherited values made
   * explicit. That produces a valid, canonical, *bigger* file whose diff claims
   * five changes for one edit, and `fmt --check` cannot see it because the bytes
   * are canonical. So the assertions are on the content, not only on `fmt`.
   */
  it("leaves the project already canonical after editing per-step and lane expression", async () => {
    store.getState().setStepEvent("drums-verse", "hat", 2, { velocity: 420 });
    store.getState().setLaneDefaults("drums-verse", "hat", { swing: 300, probability: 950 });
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));

    const pattern = reloaded.project!.patterns.get("drums-verse")!;
    if (pattern.kind !== "grid") throw new Error("the pattern stopped being a grid");
    const hat = pattern.lanes.find((lane) => lane.lane === "hat")!;
    // One field of one entry moved. `probability: 800` on step 2 is still there
    // rather than having been re-stated or dropped, step 8 is untouched, and the
    // lane gained exactly the two defaults asked for beside the velocity it had.
    expect(hat.stepEvents).toEqual([
      { step: 2, velocity: 420, probability: 800 },
      { step: 8, microTicks: -12, gateTicks: 120, ratchet: 2 },
    ]);
    expect(hat.defaults).toEqual({ velocity: 600, probability: 950, swing: 300 });
    expect(hat.steps).toBe("x.x. x.x. x.x. x.x.");
    // And the lane nobody touched is byte-for-byte what it was.
    expect(pattern.lanes.find((lane) => lane.lane === "kick")).toEqual({
      lane: "kick",
      grid: { stepsPerBar: 16 },
      steps: "x..x ..x. x..x ..x.",
    });
  });

  /**
   * Clearing an override must remove it, not write the value it was inheriting.
   * The difference is invisible in the sound and very visible in the file, which
   * is exactly the kind of divergence a byte-level test is for.
   */
  it("removes a cleared override instead of writing the inherited value back", async () => {
    store.getState().setStepEvent("drums-verse", "hat", 2, { probability: undefined });
    store.getState().setStepEvent("drums-verse", "hat", 8, {
      microTicks: undefined,
      gateTicks: undefined,
      ratchet: undefined,
    });
    await store.getState().flushNow();

    expect(fmtCheck().stdout).toBe("already canonical\n");
    const text = readFileSync(join(root, "patterns/drums-verse.json"), "utf8");
    expect(text).not.toContain("probability");
    // Step 8 had nothing left, so its whole entry went with it.
    expect(text).not.toContain('"step": 8');
    const pattern = loadProject(root).project!.patterns.get("drums-verse")!;
    if (pattern.kind !== "grid") throw new Error("the pattern stopped being a grid");
    expect(pattern.lanes.find((lane) => lane.lane === "hat")!.stepEvents).toEqual([{ step: 2, velocity: 350 }]);
  });

  it("leaves the project already canonical after editing an automation curve", async () => {
    store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 26_880, 6500);
    store.getState().addAutomationPoint("pad", "filter.cutoff", 46_080, 1200);
    store.getState().setAutomationInterp("pad", "filter.cutoff", "step");
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);

    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    expect(reloaded.project!.automation.get("pad")!.lanes).toEqual([
      {
        param: "filter.cutoff",
        interp: "step",
        // Strictly increasing, with the untouched points exactly as they were.
        points: [
          [0, 200],
          [26_880, 6500],
          [46_080, 1200],
          [61_440, 800],
        ],
      },
    ]);
  });

  it("creates a track's first automation file in canonical bytes", async () => {
    expect(existsSync(join(root, "automation/bass.json"))).toBe(false);

    store.getState().addAutomationLane("bass", "gain");
    store.getState().addAutomationPoint("bass", "gain", 30_720, -2400);
    await store.getState().flushNow();

    const check = fmtCheck();
    expect(check.stdout).toBe("already canonical\n");
    expect(check.code).toBe(0);
    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(onDisk()).toEqual(canonicalFiles(reloaded.project!));
    // Seeded from the instrument's own `gain` of -1000 (PLAN.md §8), not from
    // the registry's 0 and not from the bottom of the range: adding a lane must
    // not change the sound.
    expect(reloaded.project!.automation.get("bass")!.lanes).toEqual([
      { param: "gain", interp: "linear", points: [[0, -1000], [30_720, -2400]] },
    ]);
  });

  it("removes the automation file when its last lane goes, rather than leaving an empty one", async () => {
    store.getState().removeAutomationLane("pad", "filter.cutoff");
    await store.getState().flushNow();

    expect(existsSync(join(root, "automation/pad.json"))).toBe(false);
    const reloaded = loadProject(root);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project!.automation.size).toBe(0);
    expect(fmtCheck().stdout).toBe("already canonical\n");
    expect(store.getState().removing).toEqual([]);
  });

  /**
   * The no-data-loss claim, stated as a property rather than field by field:
   * after one edit, every document except the one edited is byte-identical, and
   * the edited one differs from its original in exactly the lines the edit was
   * about.
   */
  it("changes one line of one file for an automation point move, and nothing else anywhere", async () => {
    const before = onDisk();

    store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 30_720, 4100);
    await store.getState().flushNow();

    const after = onDisk();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of after) {
      if (path === "automation/pad.json") continue;
      expect(text, `${path} was rewritten by an edit to automation/pad.json`).toBe(before.get(path));
    }
    const changed = diffLines(before.get("automation/pad.json")!, after.get("automation/pad.json")!);
    expect(changed).toEqual([{ before: "        [30720, 4000],", after: "        [30720, 4100]," }]);
  });

  /**
   * Adding an effect is the first UI edit that touches two files at once, and the
   * only one that changes `format`. Both halves are asserted line by line: the chain
   * appears in the track file and nowhere else, and `project.json` gains the version
   * bump and nothing else.
   *
   * The version bump is deliberately not silent. `AGENTS.md` tells agents never to
   * touch `format`, so a tool doing it on their behalf has to be visible, and one
   * line in `project.json` in the same write batch as the chain that required it is
   * what visible looks like.
   */
  it("adds an effect chain and bumps format to 2, changing nothing else in either file", async () => {
    const before = onDisk();
    expect(before.get("project.json")).toContain('"format": 1');

    store.getState().addEffect("bass", "slap", "delay");
    await store.getState().flushNow();

    const after = onDisk();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of after) {
      if (path === "tracks/bass.json" || path === "project.json") continue;
      expect(text, `${path} was rewritten by adding an effect to tracks/bass.json`).toBe(before.get(path));
    }
    // The only change to project.json is the version the chain requires.
    expect(diffLines(before.get("project.json")!, after.get("project.json")!)).toEqual([
      { before: '  "format": 1,', after: '  "format": 2,' },
    ]);
    // The chain is appended with no params: the registry's defaults are said by
    // their absence, exactly as an instrument's are.
    expect(after.get("tracks/bass.json")).toBe(
      `{
  "id": "bass",
  "type": "instrument",
  "instrument": "bass-synth",
  "patterns": ["bass-main"],
  "effects": [
    {
      "id": "slap",
      "type": "delay"
    }
  ]
}
`,
    );
    expect(fmtCheck().stdout).toBe("already canonical\n");
    expect(loadProject(root).ok).toBe(true);
  });

  it("changes one line of one file for an effect param edit, and nothing else anywhere", async () => {
    store.getState().addEffect("bass", "slap", "delay");
    store.getState().setEffectParam("bass", "slap", "mix", 600);
    await store.getState().flushNow();
    const before = onDisk();

    store.getState().setEffectParam("bass", "slap", "mix", 450);
    await store.getState().flushNow();

    const after = onDisk();
    for (const [path, text] of after) {
      if (path === "tracks/bass.json") continue;
      expect(text, `${path} was rewritten by an effect param edit`).toBe(before.get(path));
    }
    expect(diffLines(before.get("tracks/bass.json")!, after.get("tracks/bass.json")!)).toEqual([
      { before: '        "mix": 600', after: '        "mix": 450' },
    ]);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  /**
   * The claim the whole id-addressing decision exists to make, asserted on bytes:
   * reordering a chain moves the effects and touches nothing else — no automation
   * lane is rewritten, because no lane names a position.
   */
  it("reorders a chain without rewriting the automation that targets it", async () => {
    store.getState().addEffect("pad", "tone", "filter");
    store.getState().addEffect("pad", "room", "reverb");
    store.getState().addAutomationLane("pad", "fx.tone.cutoff");
    await store.getState().flushNow();
    const before = onDisk();
    expect(before.get("automation/pad.json")).toContain('"fx.tone.cutoff"');

    store.getState().moveEffect("pad", "room", 0);
    await store.getState().flushNow();

    const after = onDisk();
    for (const [path, text] of after) {
      if (path === "tracks/pad.json") continue;
      expect(text, `${path} was rewritten by reordering tracks/pad.json's chain`).toBe(before.get(path));
    }
    // The chain really did move, and the lane still names the same effect.
    const chain = JSON.parse(after.get("tracks/pad.json")!) as { effects: { id: string }[] };
    expect(chain.effects.map((effect) => effect.id)).toEqual(["room", "tone"]);
    expect(after.get("automation/pad.json")).toContain('"fx.tone.cutoff"');
    expect(fmtCheck().stdout).toBe("already canonical\n");
    expect(loadProject(root).ok).toBe(true);
  });

  /**
   * Removing an effect takes its automation with it, because a lane naming an absent
   * effect is `ref.missing-effect` — a document the validator rejects is worse than
   * an edit that visibly removes the lane. Here the lane was the file's only one, so
   * the file goes.
   */
  it("removes an effect and the automation that targeted it, leaving a valid project", async () => {
    store.getState().addEffect("drums", "room", "reverb");
    store.getState().addAutomationLane("drums", "fx.room.mix");
    await store.getState().flushNow();
    expect(onDisk().has("automation/drums.json")).toBe(true);

    store.getState().removeEffect("drums", "room");
    await store.getState().flushNow();

    const after = onDisk();
    expect(after.has("automation/drums.json")).toBe(false);
    expect(existsSync(join(root, "automation/drums.json"))).toBe(false);
    expect(after.get("tracks/drums.json")).not.toContain("effects");
    // `format` is not walked back: nothing requires 2 any more, but a project's
    // version is not something an edit should quietly lower either.
    expect(after.get("project.json")).toContain('"format": 2');
    expect(loadProject(root).ok).toBe(true);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  it("writes exactly the bytes the store held, with no server-side reformatting", async () => {
    store.getState().setProjectName("Byte for byte");
    const expected = store.getState().canonical.get("project.json");
    await store.getState().flushNow();

    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(expected);
  });

  it("touches only the file that changed, leaving the other ten alone", async () => {
    const before = new Map([...onDisk().keys()].map((path) => [path, statSync(join(root, path)).mtimeMs]));
    expect(before.size).toBe(11);
    // A coarse clock would make "unchanged mtime" meaningless; a real pause is
    // cheaper than reasoning about filesystem timestamp granularity.
    await new Promise((resolve) => setTimeout(resolve, 20));

    store.getState().setPatternLaneSteps("drums-verse", "kick", "x..x x..x x..x x..x");
    await store.getState().flushNow();

    const after = new Map([...onDisk().keys()].map((path) => [path, statSync(join(root, path)).mtimeMs]));
    const rewritten = [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path);
    expect(rewritten).toEqual(["patterns/drums-verse.json"]);
  });

  it("bites: the server refuses the bytes a hand-rolled serializer would produce", async () => {
    // What a UI that reached for `JSON.stringify` instead of `canonicalFiles`
    // would send. Same document, same values, different bytes — and the write
    // path is where that has to stop, because by the time it is on disk the
    // damage is a dirty diff nobody asked for.
    const project = loadProject(root).project!;
    const naive = `${JSON.stringify({ ...project.project, name: "Hand rolled" }, null, 2)}\n`;
    const before = readFileSync(join(root, "project.json"), "utf8");

    const response = await post(
      "/api/projects/p/write",
      JSON.stringify({ files: [{ path: "project.json", contents: naive, expectedHash: hashText(before) }] }),
    );

    expect(response.status).toBe(422);
    expect(response.body).toContain("canonical");
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(before);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  /**
   * The grid assertions above are only worth anything if `fmt --check` would notice
   * a wrongly grouped `steps` string. This writes exactly what a UI that formatted
   * the string itself would produce — a valid 16-step lane with the spaces in the
   * wrong places — and confirms the check names it.
   */
  it("bites for the grid: a valid but wrongly grouped steps string is reported as a steps-grouping change", () => {
    const path = join(root, "patterns/drums-verse.json");
    const ungrouped = readFileSync(path, "utf8").replace('"x.x. x.x. x.x. x.x."', '"x.x.x.x.x.x.x.x."');
    expect(ungrouped).toContain('"x.x.x.x.x.x.x.x."');
    writeFileSync(path, ungrouped);

    // Still a project the loader accepts: this is a formatting difference, not a
    // broken document, which is exactly why only `fmt` can catch it.
    expect(loadProject(root).ok).toBe(true);
    const check = fmtCheck();

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite patterns/drums-verse.json");
    expect(check.stdout).toContain("steps grouping");
  });

  /**
   * The effect assertions above are only worth anything if `fmt --check` would
   * notice a chain written the wrong way. Two ways, in fact, and they are different
   * failures: a chain whose keys are in the wrong order, and one whose `params` map
   * is not alphabetical. Both are documents the loader accepts — only `fmt` can
   * catch either — so without this case the byte comparisons could be passing on a
   * serializer that does not really own the chain.
   */
  it("bites for effects: a chain with the wrong key order or unsorted params is reported", async () => {
    store.getState().addEffect("bass", "slap", "delay");
    store.getState().setEffectParam("bass", "slap", "mix", 600);
    store.getState().setEffectParam("bass", "slap", "time", 250);
    await store.getState().flushNow();
    const path = join(root, "tracks/bass.json");
    const canonical = readFileSync(path, "utf8");
    // Canonical form is `time` after `mix`, because `params` is an open map and is
    // sorted alphabetically.
    expect(canonical.indexOf('"mix"')).toBeLessThan(canonical.indexOf('"time"'));

    const doc = JSON.parse(canonical) as { effects: { id: string; type: string; params: Record<string, number> }[] };
    // A hand-written chain: `type` before `id`, and params in the order someone
    // happened to type them.
    const effect = doc.effects[0]!;
    const handWritten = {
      ...doc,
      effects: [{ type: effect.type, id: effect.id, params: { time: effect.params.time, mix: effect.params.mix } }],
    };
    writeFileSync(path, `${JSON.stringify(handWritten, null, 2)}\n`);

    expect(loadProject(root).ok).toBe(true);
    const check = fmtCheck();
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite tracks/bass.json");
    expect(check.stdout).toContain("key order");
  });

  it("bites for notes: a note list in the wrong order is reported as a sort-order change", () => {
    const path = join(root, "patterns/bass-main.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { notes: unknown[] };
    doc.notes.reverse();
    // Serialized canonically apart from the order, so `sort order` is the only
    // aspect that can be reported and the assertion cannot pass on a stray space.
    writeFileSync(path, serializeCanonical(doc as never, "pattern.notes"));

    expect(loadProject(root).ok).toBe(true);
    const check = fmtCheck();

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite patterns/bass-main.json");
    expect(check.stdout).toContain("sort order");
  });

  /**
   * The automation assertions above are only worth anything if `fmt --check`
   * would notice an automation file written the obvious wrong way. `fmt` puts
   * each `[tick, value]` pair on one line (docs/format-spec.md §5.2), which is
   * precisely what a generic pretty-printer does not do, so that is the shape to
   * test with.
   */
  it("bites for automation: a pretty-printed points array is reported by fmt", () => {
    const path = join(root, "automation/pad.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

    // Still a project the loader accepts: this is layout, not a broken document,
    // which is exactly why only `fmt` can catch it.
    expect(loadProject(root).ok).toBe(true);
    const check = fmtCheck();

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite automation/pad.json");
  });

  it("bites for automation: the server refuses hand-rolled automation bytes", async () => {
    const path = join(root, "automation/pad.json");
    const before = readFileSync(path, "utf8");
    const naive = `${JSON.stringify(JSON.parse(before), null, 2)}\n`;
    expect(naive).not.toBe(before);

    const response = await post(
      "/api/projects/p/write",
      JSON.stringify({ files: [{ path: "automation/pad.json", contents: naive, expectedHash: hashText(before) }] }),
    );

    expect(response.status).toBe(422);
    expect(response.body).toContain("canonical");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  /**
   * The deletion path's own precondition. Without it a window that has been open
   * across an agent's edit would remove a file it has never read — the lost
   * update the write path's `expectedHash` exists to prevent, in the one shape
   * where the loss is total.
   */
  it("bites for deletion: a stale precondition refuses the removal and writes nothing", async () => {
    const path = join(root, "automation/pad.json");
    const before = readFileSync(path, "utf8");

    const response = await post(
      "/api/projects/p/write",
      JSON.stringify({ files: [], deletes: [{ path: "automation/pad.json", expectedHash: hashText("not these bytes") }] }),
    );

    expect(response.status).toBe(409);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("bites the other way: a non-canonical file on disk is reported by fmt, so the check is not vacuous", () => {
    // If `fmt --check` said "already canonical" no matter what, every assertion
    // above would pass for the wrong reason.
    const project = loadProject(root).project!;
    writeFileSync(join(root, "project.json"), `${JSON.stringify(project.project, null, 4)}\n`);

    const check = fmtCheck();

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("would rewrite project.json");
  });
});

describe("an external edit is refused, not overwritten", () => {
  it("stops the store writing over a file that changed underneath it", async () => {
    // Exactly the sequence that made this necessary: the app is open, its model
    // is written once, something else rewrites the file, and the app edits again.
    store.getState().setProjectName("Written by the UI");
    await store.getState().flushNow();
    expect(readFileSync(join(root, "project.json"), "utf8")).toContain('"name": "Written by the UI"');

    const external = readFileSync(join(root, "project.json"), "utf8").replace(
      '"name": "Written by the UI"',
      '"name": "Written by the agent"',
    );
    writeFileSync(join(root, "project.json"), external);

    store.getState().setProjectName("Written by the UI, second time");
    await store.getState().flushNow();

    // The agent's edit survives, the UI knows why, and it has stopped writing.
    expect(readFileSync(join(root, "project.json"), "utf8")).toBe(external);
    expect(loadProject(root).project!.project.name).toBe("Written by the agent");
    expect(store.getState().conflict?.paths).toEqual(["project.json"]);
    expect(store.getState().dirty).toEqual(["project.json"]);
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });

  it("recovers once the store reopens the project from disk", async () => {
    writeFileSync(
      join(root, "project.json"),
      readFileSync(join(root, "project.json"), "utf8").replace('"name": "first track"', '"name": "Agent wrote this"'),
    );
    store.getState().setProjectName("Stale");
    await store.getState().flushNow();
    expect(store.getState().conflict).toBeDefined();

    store.getState().open(openedFrom(root));
    expect(store.getState().project!.project.name).toBe("Agent wrote this");
    store.getState().setProjectName("Now allowed");
    await store.getState().flushNow();

    expect(store.getState().conflict).toBeUndefined();
    expect(loadProject(root).project!.project.name).toBe("Now allowed");
    expect(fmtCheck().stdout).toBe("already canonical\n");
  });
});
