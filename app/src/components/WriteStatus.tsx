import { useState } from "react";
import { useStore } from "zustand";
import { documentStore, loadProjectIntoStore } from "../session";

/**
 * What the store is about to write, is writing, and last heard back.
 *
 * Visible rather than buried, because "changing a hi-hat touches one file"
 * (PLAN.md §4) is a property that has to stay true as the app grows, and the
 * cheapest way to notice it breaking is to be able to see the file list.
 */
export function WriteStatus(): React.JSX.Element {
  const [reloadError, setReloadError] = useState<string | undefined>(undefined);
  const dirty = useStore(documentStore, (state) => state.dirty);
  const writing = useStore(documentStore, (state) => state.writing);
  const batches = useStore(documentStore, (state) => state.batchesWritten);
  const error = useStore(documentStore, (state) => state.lastWriteError);
  const conflict = useStore(documentStore, (state) => state.conflict);
  const unformatted = useStore(documentStore, (state) => state.unformatted);
  const diagnostics = useStore(documentStore, (state) => state.diagnostics);
  const flushNow = useStore(documentStore, (state) => state.flushNow);

  return (
    <section>
      <h2>writes</h2>
      <div className="status">
        <span>pending</span>
        <span>{dirty.length === 0 ? "nothing to write" : dirty.join(", ")}</span>
        <span>in flight</span>
        <span>{writing.length === 0 ? "-" : writing.join(", ")}</span>
        <span>batches written</span>
        <span>{batches}</span>
      </div>
      <p>
        <button type="button" onClick={() => void flushNow()} disabled={dirty.length === 0 || conflict !== undefined}>
          write now
        </button>{" "}
        <span className="muted">
          {conflict === undefined ? "edits are written automatically after a short pause" : "writing is paused"}
        </span>
      </p>
      {conflict !== undefined && (
        <div>
          {/*
            Stated plainly rather than smoothed over. Something else — an agent,
            an editor, a `musictool fmt` — changed these files while this window
            held an older copy, so continuing to write would destroy that work.
            Reloading is the only honest option on offer until Phase 4 can
            reconcile the two versions; it discards the edits made here, and says so.
          */}
          <p className="error">
            {conflict.paths.join(", ")} changed on disk while this window was open. Nothing was written, and nothing
            more will be written until you reload.
          </p>
          <p className="muted">{conflict.message}</p>
          <p>
            <button
              type="button"
              onClick={() => {
                setReloadError(undefined);
                loadProjectIntoStore().catch((cause: unknown) =>
                  setReloadError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
            >
              reload from disk (discards the edits made here)
            </button>
          </p>
          {reloadError !== undefined && <p className="error">reload failed: {reloadError}</p>}
        </div>
      )}
      {error !== undefined && <p className="error">write failed: {error}</p>}
      {unformatted.length > 0 && (
        <p className="muted">
          not canonical on disk, left alone until edited: {unformatted.join(", ")} — run <code>musictool fmt</code> to
          tidy them
        </p>
      )}
      {diagnostics.length > 0 && (
        <>
          <h2>diagnostics</h2>
          <ul>
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.file}-${diagnostic.code}-${index}`} className={diagnostic.severity === "error" ? "error" : "muted"}>
                {diagnostic.severity} {diagnostic.file}: {diagnostic.code} {diagnostic.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
