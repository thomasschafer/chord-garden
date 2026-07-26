import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * The state of this window's *connection* to the sidecar, kept out of the
 * document store on purpose: none of it is a property of the music, and PLAN.md
 * §10 puts the document — not the transport — at the centre.
 *
 * There is deliberately no "this window is behind the disk" state. A reconnecting
 * page tells the sidecar which disk state it holds and is sent a full snapshot when
 * that is no longer the disk (PLAN.md §12), so being behind is a condition that
 * resolves itself rather than one to display and wait for a human to act on.
 */
export interface SyncState {
  connection: "connecting" | "live" | "dropped";
  /** Why the connection dropped, if it did. A retry is already scheduled. */
  detail: string | undefined;
  /**
   * Set when the sidecar refused this window for good. `alreadyOpen` is PLAN.md
   * §12's single-writer rule: another window is editing this project.
   */
  rejected: { kind: "alreadyOpen" | "refused"; message: string } | undefined;
  /** The project could not be loaded over HTTP. */
  loadError: string | undefined;
}

export type SyncStore = StoreApi<SyncState>;

export function createSyncStore(): SyncStore {
  return createStore<SyncState>(() => ({
    connection: "connecting",
    detail: undefined,
    rejected: undefined,
    loadError: undefined,
  }));
}
