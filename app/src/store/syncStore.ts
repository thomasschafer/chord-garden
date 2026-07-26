import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * The state of this window's *connection* to the sidecar, kept out of the
 * document store on purpose: none of it is a property of the music, and PLAN.md
 * §10 puts the document — not the transport — at the centre.
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
  /**
   * Set when the socket came back but this window could not safely catch up,
   * because it holds unsaved edits and a reload would discard them. Changes made
   * while it was disconnected were announced to nobody, so it is behind and says
   * so rather than pretending otherwise.
   */
  behind: string | undefined;
}

export type SyncStore = StoreApi<SyncState>;

export function createSyncStore(): SyncStore {
  return createStore<SyncState>(() => ({
    connection: "connecting",
    detail: undefined,
    rejected: undefined,
    loadError: undefined,
    behind: undefined,
  }));
}
