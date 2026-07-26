import type { LiveEditEffect } from "@chord-garden/engine/live";
import type { Project } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import { connectAudioToDocument } from "../src/audio/documentBridge";
import { createDocumentStore, type DocumentSink, type DocumentStore, type PendingFile } from "../src/store/documentStore";
import { FIXTURE, openedFrom } from "./fixture";

/**
 * The link that makes editing during playback audible.
 *
 * Stage 1 shipped without it and the result read as a bug: an edit changed the file
 * and not the sound. Tested with a recording double for the player, because what is
 * under test is which edits reach the engine and what they are called — the engine's
 * own behaviour on receiving them is `packages/engine/test/liveSessionEdit.test.ts`.
 */

class RecordingPlayer {
  readonly applied: { effect: LiveEditEffect; project: Project }[] = [];
  async applyDocumentEdit(project: Project, effect: LiveEditEffect): Promise<void> {
    this.applied.push({ project, effect });
  }
}

const nullSink: DocumentSink = {
  async write(_files: readonly PendingFile[]) {
    return { diagnostics: [] };
  },
};

function open(): { store: DocumentStore; player: RecordingPlayer; disconnect: () => void } {
  const store = createDocumentStore({ sink: nullSink, debounceMs: 10_000 });
  const player = new RecordingPlayer();
  const disconnect = connectAudioToDocument(store, player);
  store.getState().open(openedFrom(FIXTURE));
  return { store, player, disconnect };
}

describe("edits reaching the live engine", () => {
  it("sends a grid toggle as a structural change, with the model it produced", () => {
    const { store, player } = open();

    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);

    expect(player.applied).toHaveLength(1);
    expect(player.applied[0]!.effect).toBe("structural");
    expect(player.applied[0]!.project).toBe(store.getState().project);
  });

  it("sends a note edit as a structural change", () => {
    const { store, player } = open();

    store.getState().addNote("bass-main", { pitch: "D2", startTick: 480, durationTicks: 240, velocity: 800 });
    store.getState().updateNote("bass-main", 0, { durationTicks: 960 });
    store.getState().deleteNote("bass-main", 1);

    expect(player.applied.map((edit) => edit.effect)).toEqual(["structural", "structural", "structural"]);
  });

  it("sends nothing for an edit no engine can hear", () => {
    const { store, player } = open();

    store.getState().setProjectName("Renamed");

    expect(player.applied).toEqual([]);
  });

  it("sends nothing for a state change that is not an edit", async () => {
    // A write completing, a conflict landing, a reopen: all of these move the store,
    // and none of them may re-send the last edit to the engine.
    const { store, player } = open();
    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);
    expect(player.applied).toHaveLength(1);

    await store.getState().flushNow();
    store.getState().open(openedFrom(FIXTURE));

    expect(player.applied).toHaveLength(1);
  });

  it("sends each edit exactly once, in order", () => {
    const { store, player } = open();

    for (const step of [1, 2, 4, 5]) store.getState().toggleGridStep("drums-verse", "kick", step, 16);

    expect(player.applied).toHaveLength(4);
    const patterns = player.applied.map((edit) => {
      const pattern = edit.project.patterns.get("drums-verse");
      if (pattern?.kind !== "grid") throw new Error("expected a grid pattern");
      return pattern.lanes.find((lane) => lane.lane === "kick")!.steps;
    });
    // Each snapshot is the document as it stood after its own edit — the engine is
    // never handed a later model for an earlier edit.
    expect(patterns).toEqual([
      "xx.x ..x. x..x ..x.",
      "xxxx ..x. x..x ..x.",
      "xxxx x.x. x..x ..x.",
      "xxxx xxx. x..x ..x.",
    ]);
  });

  it("sends nothing after being disconnected", () => {
    const { store, player, disconnect } = open();

    disconnect();
    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);

    expect(player.applied).toEqual([]);
  });

  it("sends nothing for an edit that was refused", () => {
    const { store, player } = open();

    expect(() => store.getState().toggleGridStep("drums-verse", "clap", 0, 16)).toThrow();

    expect(player.applied).toEqual([]);
  });
});
