import { useStore } from "zustand";
import { documentStore, loadProjectIntoStore, syncStore } from "../session";

/**
 * What the disk is doing, and what this window did about it.
 *
 * Every state here is one the human has to be able to see, because PLAN.md §12's
 * concurrency policy is "last-writer-wins with a visible warning" and a warning
 * nobody renders is not one. In particular: an unsaved edit replaced by an
 * agent's version says so and names the file, and a project that stopped
 * validating on disk says that too, rather than the UI quietly freezing.
 */
export function SyncStatus(): React.JSX.Element {
  const connection = useStore(syncStore, (state) => state.connection);
  const detail = useStore(syncStore, (state) => state.detail);
  const behind = useStore(syncStore, (state) => state.behind);
  const diskValid = useStore(documentStore, (state) => state.diskValid);
  const outOfSync = useStore(documentStore, (state) => state.outOfSync);
  const external = useStore(documentStore, (state) => state.lastExternalEdit);
  const accepted = useStore(documentStore, (state) => state.externalEditsAccepted);
  const dirty = useStore(documentStore, (state) => state.dirty);

  return (
    <section>
      <h2>disk</h2>
      <div className="status">
        <span>watcher</span>
        <span className={connection === "live" ? undefined : "error"}>
          {connection === "live" ? "watching for external edits" : connection === "connecting" ? "connecting…" : `disconnected — ${detail ?? "retrying"}`}
        </span>
        <span>external edits</span>
        <span>
          {accepted === 0 ? "none yet" : `${accepted} accepted`}
          {external !== undefined && external.adopted.length > 0 ? ` — last: ${external.adopted.join(", ")}` : ""}
          {external !== undefined && external.removed.length > 0 ? ` — removed: ${external.removed.join(", ")}` : ""}
        </span>
      </div>

      {!diskValid && (
        <p className="error">
          the project on disk does not currently validate, so nothing from it has been adopted. This window is still
          playing the last valid version; the diagnostics below are from disk. If an agent is part-way through a
          multi-file edit this will clear itself when the edit finishes.
        </p>
      )}

      {external !== undefined && external.discarded.length > 0 && (
        <p className="error">
          {external.discarded.join(", ")} changed on disk while this window had unsaved edits to{" "}
          {external.discarded.length === 1 ? "it" : "them"}. The version on disk won, and those unsaved edits are gone.
        </p>
      )}

      {behind !== undefined && (
        <p className="error">
          {behind}.{" "}
          <button
            type="button"
            onClick={() => {
              void loadProjectIntoStore();
            }}
          >
            reload from disk (discards {dirty.length} unsaved {dirty.length === 1 ? "file" : "files"})
          </button>
        </p>
      )}

      {outOfSync !== undefined && (
        <p className="error">
          this window can no longer prove its copy of the project matches the disk, so it has stopped following it:{" "}
          {outOfSync}.{" "}
          <button
            type="button"
            onClick={() => {
              void loadProjectIntoStore();
            }}
          >
            reload from disk
          </button>
        </p>
      )}
    </section>
  );
}
