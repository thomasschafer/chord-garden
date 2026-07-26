import type { LiveEditEffect } from "@chord-garden/engine/live";
import type { Project } from "@chord-garden/format/pure";
import type { DocumentStore } from "../store/documentStore";

/** The part of `LivePlayer` the bridge needs; narrowed so a test can stand in. */
export interface EditableAudio {
  applyDocumentEdit(project: Project, effect: LiveEditEffect): Promise<void>;
}

/**
 * Make edits audible: every document edit that an engine could hear is handed to
 * the live engine as it happens.
 *
 * Outside React on purpose. The store and the player both outlive any component,
 * and an editor should not have to remember to tell the audio engine about itself —
 * stage 1 shipped without this link and the result read as a bug (a change that
 * updated the file and not the sound). One subscription covers every editor,
 * present and future.
 *
 * Edits are keyed by revision rather than by object identity so a state change that
 * is not an edit — a write completing, a conflict arriving — cannot re-send the
 * last edit, and so a burst of edits sends the latest of them at most once each.
 * `LiveSession.update` serializes them and the scheduler collapses a queued
 * structural change into its replacement, so a drag that produces twenty edits
 * costs twenty recompiles and one graph swap.
 */
export function connectAudioToDocument(store: DocumentStore, player: EditableAudio): () => void {
  let lastSeenRevision = 0;
  return store.subscribe((state) => {
    const edit = state.audioEdit;
    if (edit === undefined || edit.revision <= lastSeenRevision) return;
    lastSeenRevision = edit.revision;
    // "none" still advances the revision: an edit nothing can hear must not leave
    // the bridge thinking it has work outstanding.
    if (edit.effect === "none") return;
    void player.applyDocumentEdit(edit.project, edit.effect);
  });
}
