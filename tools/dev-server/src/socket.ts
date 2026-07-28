import {
  CLOSE_ALREADY_OPEN,
  SOCKET_PATH,
  SYNC_PROTOCOL,
  type HelloMessage,
  type ProjectChangedMessage,
  type ProjectInvalidMessage,
  type SampleFile,
  type SamplesChangedMessage,
  type ServerMessage,
} from "./api.js";

/**
 * The browser's half of the sync protocol (PLAN.md §12).
 *
 * Free of DOM types on purpose, for the same reason `client.ts` is: this file is
 * compiled by the Node-typed build alongside the server it talks to, and by the
 * app's DOM-typed build. So it does not touch `WebSocket` itself — it is handed a
 * transport factory, and the twelve lines that wire a real `WebSocket` to it live
 * in the app, where `location` and `WebSocket` are real. Node's own WebSocket
 * client satisfies the same factory, which is how the tests drive the sidecar
 * over a real socket without a browser.
 */

/** A live connection. Only what this protocol actually uses. */
export interface SyncTransport {
  send(text: string): void;
  close(): void;
}

export interface SyncTransportHandlers {
  open(): void;
  text(data: string): void;
  closed(code: number, reason: string): void;
  failed(message: string): void;
}

/** Opens a transport to a same-origin path such as `/api/projects/x/socket`. */
export type SyncTransportFactory = (path: string, handlers: SyncTransportHandlers) => SyncTransport;

/**
 * Why the sidecar refused this session, once retrying has been ruled out.
 *
 * Both cases here are terminal. A refused *token* is deliberately not one of them:
 * a page can only talk to the origin that served it, so a token this sidecar does
 * not recognise means it restarted and minted a new one, and the answer is to fetch
 * the current token and hand the handshake back — not to replace the page with a
 * security notice and drop whatever it had not written yet.
 */
export type SyncRejection =
  | { kind: "alreadyOpen"; message: string }
  | { kind: "refused"; message: string };

export interface ProjectSocketHandlers {
  /**
   * The session is live. `reconnected` is false only for the first connection of
   * the page's life.
   *
   * On the first connection the caller must load the project over HTTP: it holds
   * nothing, and the sidecar has nothing to compare it against.
   *
   * On a reconnect it need not. The hello carried this page's inventory (see
   * `ProjectSocketOptions.inventory`), so the sidecar has already decided whether
   * the disk moved while the socket was down and pushes a full snapshot if it did.
   * That matters because the caller may hold unsaved edits, and an HTTP reload
   * discards them — which used to leave the only options as "lose the edits" or
   * "sit here out of date until a human chooses".
   */
  ready(reconnected: boolean): void;
  changed(message: ProjectChangedMessage): void;
  /**
   * Sample files on disk are no longer the ones this page is playing. Separate from
   * `changed` because no document moved: nothing here reaches the document store, and
   * the only thing that has to happen is that the audio engine adopts the new bytes.
   */
  samplesChanged(message: SamplesChangedMessage): void;
  invalid(message: ProjectInvalidMessage): void;
  /** The sidecar will not admit this session. Nothing will retry. */
  rejected(rejection: SyncRejection): void;
  /** The connection dropped and a retry is scheduled. */
  dropped(reason: string): void;
  /**
   * A *message* this page could not make sense of. Never silently dropped: a page
   * discarding pushes it does not understand has stopped following the disk
   * without telling anyone. Transport failures do not come through here — they
   * arrive as `dropped`, because a retry fixes those and a reload does not.
   */
  protocolError(message: string): void;
}

export interface ProjectSocketOptions {
  project: string;
  token: string;
  factory: SyncTransportFactory;
  handlers: ProjectSocketHandlers;
  /**
   * What this page currently holds, as an `inventoryHash`, or `undefined` when it
   * holds nothing yet.
   *
   * Consulted on every connection attempt rather than once, because the answer is
   * exactly "the disk state this page is caught up to at this moment", and that is
   * what lets the sidecar replay what a dropped connection missed.
   */
  inventory?: () => string | undefined;
  /**
   * The sample content this page holds, consulted on every connection attempt for
   * the same reason `inventory` is: what matters is what it holds *now*.
   *
   * Separate from `inventory` because samples are fetched lazily — a page that has
   * never played holds none — so a page can be exactly in step with the disk's
   * documents while its audio is a version behind, and only this can say so.
   */
  samples?: () => readonly SampleFile[] | undefined;
  /**
   * Fetch the sidecar's current session token, for when the one this page holds is
   * refused because the sidecar restarted.
   *
   * A page without one keeps the old behaviour — a refused token is terminal —
   * because there is then no way to come by a better one. Returning the *same* token
   * is fine and expected in a race with a sidecar that is still shutting down; the
   * handshake simply gets tried again until `maxTokenRefusals` runs out.
   */
  refreshToken?: () => Promise<string>;
  /**
   * How many consecutive token refusals to answer with a re-handshake before
   * concluding this really is a refusal. Bounded so a client that is genuinely
   * unwelcome does not retry for ever, and reset by every successful welcome.
   */
  maxTokenRefusals?: number;
  /** Retry delays, in order; the last one repeats. */
  retryDelaysMs?: readonly number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_RETRIES = [250, 1000, 3000, 10_000] as const;

/**
 * Re-handshakes to attempt after a token refusal before giving up.
 *
 * Spans the whole retry ladder, so a sidecar that is slow to come back up is waited
 * out rather than declared hostile.
 */
const DEFAULT_MAX_TOKEN_REFUSALS = 5;

export class ProjectSocket {
  private transport: SyncTransport | undefined;
  private attempt = 0;
  private connections = 0;
  private retry: unknown;
  private stopped = false;
  private sessionId: string | undefined;
  /** The token in use, which a sidecar restart replaces. */
  private token: string;
  /** Consecutive token refusals; reset by a welcome. */
  private tokenRefusals = 0;
  /**
   * In flight while a refused token is being replaced, resolving to the reason the
   * retry will report. Held rather than acted on directly because the sidecar closes
   * the socket immediately after refusing it, and both that close and the fetch
   * completing would otherwise each schedule a reconnect.
   */
  private tokenRefresh: Promise<string> | undefined;
  private readonly retryDelays: readonly number[];
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ProjectSocketOptions) {
    this.token = options.token;
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRIES;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get path(): string {
    return `/api/projects/${encodeURIComponent(this.options.project)}/${SOCKET_PATH}`;
  }

  /**
   * The read-write session id for this connection, or `undefined` while there is
   * no live session (PLAN.md §12). Every write must present it, so a page whose
   * socket has dropped — or that was refused as a second window — cannot write.
   */
  get session(): string | undefined {
    return this.sessionId;
  }

  connect(): void {
    if (this.stopped || this.transport !== undefined) return;
    let settled = false;
    let transportError: string | undefined;
    const transport = this.options.factory(this.path, {
      open: () => {
        // First-message authentication (PLAN.md §10): the token goes in a frame,
        // never in the URL, so it cannot end up in a log or a Referer.
        const inventory = this.options.inventory?.();
        const samples = this.options.samples?.();
        const hello: HelloMessage = {
          type: "hello",
          protocol: SYNC_PROTOCOL,
          token: this.token,
          project: this.options.project,
          ...(inventory === undefined ? {} : { inventory }),
          ...(samples === undefined || samples.length === 0 ? {} : { samples }),
        };
        transport.send(JSON.stringify(hello));
      },
      text: (data) => {
        this.receive(data, () => {
          settled = true;
        });
      },
      closed: (code, reason) => {
        this.transport = undefined;
        // The session died with the socket. Kept out of the way rather than left
        // behind, so a write attempted while disconnected fails locally instead of
        // presenting a credential the sidecar has already retired.
        this.sessionId = undefined;
        if (this.stopped) return;
        if (code === CLOSE_ALREADY_OPEN) {
          // Handled when the `rejected` message arrived; retrying would be a
          // second window fighting the first for the project.
          return;
        }
        const refreshing = this.tokenRefresh;
        if (refreshing !== undefined) {
          // A refused token, already being replaced. The reconnect waits for the new
          // token rather than racing it, so the retry cannot go out still holding the
          // token that was just refused.
          this.tokenRefresh = undefined;
          void refreshing.then((why) => {
            if (!this.stopped) this.scheduleRetry(why);
          });
          return;
        }
        if (!settled && code === 1006) {
          // Never opened: no sidecar listening, or an upgrade it refused before
          // the handshake completed. Worth retrying, and worth saying.
          this.scheduleRetry(reason.length > 0 ? reason : (transportError ?? "could not open the sync socket"));
          return;
        }
        this.scheduleRetry(reason.length > 0 ? `${reason} (${code})` : `connection closed (${code})`);
      },
      failed: (message) => {
        // Kept for the close that always follows, rather than reported as a
        // protocol error: the socket failing is a reconnect, not a desync.
        transportError = message;
      },
    });
    this.transport = transport;
  }

  /** Stop for good: no retries, no callbacks. */
  close(): void {
    this.stopped = true;
    this.sessionId = undefined;
    if (this.retry !== undefined) {
      this.clearTimer(this.retry);
      this.retry = undefined;
    }
    this.transport?.close();
    this.transport = undefined;
  }

  private receive(data: string, markSettled: () => void): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      this.options.handlers.protocolError(`the sidecar sent something that is not JSON: ${String(error)}`);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      this.options.handlers.protocolError("the sidecar sent a message with no type");
      return;
    }
    const message = parsed as ServerMessage;
    switch (message.type) {
      case "welcome": {
        markSettled();
        if (message.protocol !== SYNC_PROTOCOL) {
          this.options.handlers.rejected({
            kind: "refused",
            message: `the sidecar speaks sync protocol ${message.protocol} and this page speaks ${SYNC_PROTOCOL}; reload the page`,
          });
          this.close();
          return;
        }
        if (typeof message.session !== "string" || message.session.length === 0) {
          // Without it this page cannot write at all, so it is not a field to
          // shrug at: a welcome without one is a sidecar this page cannot work with.
          this.options.handlers.rejected({
            kind: "refused",
            message: "the sidecar's welcome carried no write session id; reload the page",
          });
          this.close();
          return;
        }
        this.sessionId = message.session;
        this.attempt = 0;
        this.tokenRefusals = 0;
        this.connections += 1;
        this.options.handlers.ready(this.connections > 1);
        return;
      }
      case "rejected":
        markSettled();
        if (message.code === "staleToken") {
          // Not a refusal to report. See `reauthenticate`.
          this.reauthenticate(message.reason);
          return;
        }
        this.stopped = true;
        this.options.handlers.rejected(
          message.code === "alreadyOpen"
            ? { kind: "alreadyOpen", message: message.reason }
            : { kind: "refused", message: message.reason },
        );
        return;
      case "error":
        markSettled();
        this.options.handlers.protocolError(`the sidecar refused this socket: ${message.message}`);
        return;
      case "projectChanged":
        if (!Array.isArray(message.files) || !Array.isArray(message.changed) || !Array.isArray(message.removed)) {
          this.options.handlers.protocolError("a projectChanged message was missing its file lists");
          return;
        }
        if (message.scope !== "diff" && message.scope !== "full") {
          // The two scopes need opposite treatment of a file the inventory does not
          // name — removed, or evidence of a desync — so a message that does not say
          // which it is cannot be applied at all.
          this.options.handlers.protocolError(
            `a projectChanged message did not say whether it carries the whole project (scope ${JSON.stringify(message.scope)})`,
          );
          return;
        }
        this.options.handlers.changed(message);
        return;
      case "samplesChanged":
        if (!Array.isArray(message.samples) || !Array.isArray(message.changed)) {
          this.options.handlers.protocolError("a samplesChanged message was missing its sample lists");
          return;
        }
        if (
          message.samples.some(
            (sample) =>
              sample === null ||
              typeof sample !== "object" ||
              typeof sample.path !== "string" ||
              typeof sample.contentHash !== "string",
          )
        ) {
          // The inventory is what the page decides from, so a malformed entry is not
          // something to skip past: acting on part of it would leave the page holding
          // audio the disk does not have and believing it was told everything.
          this.options.handlers.protocolError("a samplesChanged message carried a sample without a path and content hash");
          return;
        }
        this.options.handlers.samplesChanged(message);
        return;
      case "projectInvalid":
        this.options.handlers.invalid(message);
        return;
      default: {
        // Unknown types are reported, not ignored: a page quietly discarding
        // messages from a newer sidecar is a page that has stopped following the
        // disk without telling anyone.
        const unknown = message as { type: string };
        this.options.handlers.protocolError(`the sidecar sent an unknown message type "${unknown.type}"`);
        return;
      }
    }
  }

  /**
   * Answer a refused token by fetching the current one and handing the handshake
   * back, instead of tearing the session down.
   *
   * This is the sidecar-restart path, and it is the whole point of telling a stale
   * token apart from a refused window. The page keeps its model, its undo history
   * and — the part that actually loses work — its unsaved edits, which go out as
   * soon as `ready` fires again with a live write session. Replacing the page with
   * "the session token is missing or wrong" instead discards all of it, and does so
   * on the strength of a restart.
   *
   * Bounded, so a client the sidecar will genuinely never admit stops eventually and
   * says so rather than spinning. The reconnect itself is scheduled by the socket's
   * `closed` handler once this fetch has settled, so the retry always carries the new
   * token and only one reconnect is ever in flight.
   */
  private reauthenticate(reason: string): void {
    this.tokenRefusals += 1;
    const refresh = this.options.refreshToken;
    const limit = this.options.maxTokenRefusals ?? DEFAULT_MAX_TOKEN_REFUSALS;
    if (refresh === undefined || this.tokenRefusals > limit) {
      // Nowhere to get a better token, or asking has stopped helping.
      this.stopped = true;
      this.options.handlers.rejected({ kind: "refused", message: reason });
      return;
    }
    this.tokenRefresh = refresh().then(
      (token) => {
        this.token = token;
        return "the sidecar restarted; re-authenticating";
      },
      // The sidecar is very likely still coming back up, which is the same situation
      // as a dropped connection and gets the same treatment: retry, do not give up,
      // and above all do not throw the page's unsaved edits away over it.
      (error: unknown) =>
        `could not fetch the sidecar's current session token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private scheduleRetry(reason: string): void {
    this.options.handlers.dropped(reason);
    const delay = this.retryDelays[Math.min(this.attempt, this.retryDelays.length - 1)]!;
    this.attempt += 1;
    this.retry = this.setTimer(() => {
      this.retry = undefined;
      this.connect();
    }, delay);
  }
}
