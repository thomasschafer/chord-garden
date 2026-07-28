import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "@chord-garden/engine/live";
import { loadProject, referencedSamplePaths, type Project } from "@chord-garden/format";
import {
  CLOSE_ALREADY_OPEN,
  CLOSE_UNAUTHORIZED,
  HELLO_TIMEOUT_MS,
  inventoryHash,
  SYNC_PROTOCOL,
  type ApiDiagnostic,
  type HelloMessage,
  type SampleFile,
  type RejectionCode,
  type ServerMessage,
  type SnapshotDocument,
  type SnapshotFile,
} from "./api.js";
import type { ProjectMount } from "./server.js";
import { constantTimeEquals } from "./token.js";
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY_VIOLATION,
  CLOSE_PROTOCOL_ERROR,
  type WebSocketConnection,
} from "./websocket.js";
import { couldBeSample, DirectoryWatcher } from "./watch.js";

/**
 * How often an authenticated socket is pinged.
 *
 * With `PONG_TIMEOUT_MS`, this bounds how long a browser that vanished without
 * closing its TCP connection — a crashed tab, a killed renderer, a suspended
 * machine — keeps this project's single write slot (PLAN.md §12). That bound is
 * what the human sees: until it expires, reopening their own project is refused
 * with "open in another window", naming a window that no longer exists.
 */
export const KEEPALIVE_MS = 5_000;

/**
 * How long a ping may go unanswered before the peer is treated as gone.
 *
 * Separate from `KEEPALIVE_MS` because when the interval was also the deadline, a
 * peer dying just after a pong went unnoticed for two full intervals. One interval
 * plus one deadline is the bound now, and it is deliberately generous relative to
 * what actually delays a pong — see `WebSocketConnection.startKeepalive`.
 */
export const PONG_TIMEOUT_MS = 5_000;

export interface ProjectSyncOptions {
  mount: ProjectMount;
  /** The session token, required in the socket's first message. */
  token: string;
  settleMs?: number;
  maxSettleMs?: number;
  /** How often the watcher re-scans an idle project (see `IDLE_RESCAN_MS`). */
  rescanMs?: number;
  keepaliveMs?: number;
  /** How long a ping may go unanswered before the socket is closed. */
  pongTimeoutMs?: number;
  /** How long an unauthenticated socket may stay silent. */
  helloTimeoutMs?: number;
  /**
   * Whether to run a real filesystem watcher. Off in tests that drive `scan()`
   * directly, so a test asserting *what* a scan concludes is not also waiting on
   * the OS to decide *when* it happens.
   */
  watchFilesystem?: boolean;
  log?: (line: string) => void;
}

/**
 * The watcher, echo detection, and the browser's push channel for one project.
 *
 * ## Echo detection (PLAN.md §12 step 3, §18's linchpin)
 *
 * This holds `established`: the exact bytes of every document as this sidecar
 * last *established* them, meaning either it wrote them itself on the UI's
 * behalf, or it has already told the UI about them. A settle scan reads the
 * project and compares. Bytes that match what was established are, by
 * definition, bytes the UI already has — its own write coming back, a `touch`, an
 * editor rewriting a file unchanged — so nothing is pushed. Bytes that differ are
 * an external edit, and are pushed.
 *
 * The thing this deliberately does *not* do is suppress events for a period after
 * a write. That is the tempting implementation and it is the one that loses an
 * agent's work: an agent edit landing in the same window as a UI write would be
 * mistaken for the echo of that write and silently dropped, with the UI then
 * overwriting it at the next keystroke. Time never enters the decision here —
 * only content does, so "someone changed this file to something other than what
 * we put there" is answered correctly no matter when it happened.
 *
 * The comparison is over full bytes rather than the content hash. The hash is
 * still what travels to the browser (it is what write preconditions are made of),
 * but the sidecar has both strings in memory, and an identity decision that can
 * silently lose an edit on a hash collision is not worth the microseconds.
 *
 * ## Validity
 *
 * `established` only advances on a snapshot that validates as a whole project, on
 * a write, or on a snapshot served over HTTP to the session holder. A half-finished
 * multi-file agent edit therefore does not consume the changes it contains: the UI
 * is told the project is invalid, nothing is adopted, and when the edit finishes
 * the *whole* set of changed files arrives in one snapshot. Cross-file edits
 * reconcile atomically as a consequence rather than by special-casing them
 * (PLAN.md §12, cross-file transactions).
 *
 * ## Deletion and recreation
 *
 * Nothing here tracks a file's *existence* over time, and that is the whole
 * answer to delete/recreate — an agent moving a file, or a tool that writes by
 * unlinking and creating rather than renaming. A file that vanishes and comes back
 * with the same bytes inside one settle window is a non-event, because the bytes on
 * disk when the dust settles are the bytes already established; one that comes
 * back different is an ordinary external edit; one that is still gone is a removal.
 * Existence is just another thing the settled disk is asked about, so there is no
 * event sequence to get wrong.
 *
 * The one case that needs its own state is a delete whose *intermediate* state was
 * reported. A removal that makes the project invalid — deleting a pattern a clip
 * plays — is reported as any other invalid state is: keep the last good model, show
 * diagnostics, adopt nothing. If the file then returns byte-identical, the disk now
 * matches `established` exactly, so a purely content-based diff would say nothing
 * and leave the UI insisting the project is broken forever. So a snapshot that
 * validates after an invalid one was reported is always announced, even when it
 * carries no changed files: the announcement is what retracts the diagnostics.
 *
 * ## Samples
 *
 * A replaced sample file is the one change that alters what the project *sounds*
 * like without altering a single document (PLAN.md §14). It therefore gets its own
 * inventory, `establishedSamples`, and its own message: there is no document to
 * reconcile, no bytes for a write precondition, and a `projectChanged` carrying a
 * change no document made would be a fiction the browser cannot check.
 *
 * The identity is the content hash rather than the full bytes, which is the one place
 * this class knowingly departs from "decide identity on full bytes". Two reasons, and
 * they both point the same way: holding a copy of every sample would mean carrying a
 * project's entire audio in the sidecar's heap, for files the 50 MB-per-file cap
 * bounds only loosely; and the content hash is *already* the identity end to end,
 * because the engine's cache and the worklet's configure check are keyed by it
 * (`sampleCache.ts`). A collision would serve the stale decode inside the engine
 * whatever this class compared, so comparing bytes here would buy nothing.
 *
 * Time still never enters it. Nothing is compared against an mtime or a size, and
 * `cp -p` preserving a timestamp changes nothing about what is noticed.
 */
export class ProjectSync {
  private readonly established = new Map<string, string>();
  /**
   * Content hash of every sample path this sidecar has established, meaning it has
   * already told the session holder about that content (or seeded it at startup).
   *
   * Entries are never removed. A kit voice can stop referencing a file and start
   * again — an agent trying one kick against another — and a page's sample cache
   * outlives the gap, so forgetting the path would let the file be replaced while
   * unreferenced and then re-adopted with nothing said about it. Keeping the stale
   * entry makes the return an ordinary difference. The map is one short string per
   * path the project has ever referenced, so nothing is saved by pruning it.
   */
  private readonly establishedSamples = new Map<string, string>();
  private readonly watcher: DirectoryWatcher | undefined;
  private readonly keepaliveMs: number;
  private readonly pongTimeoutMs: number;
  private readonly log: (line: string) => void;
  /**
   * The one read-write session (PLAN.md §12, single-writer). Held rather than a
   * set: a second editing browser is refused, not queued.
   */
  private editor: WebSocketConnection | undefined;
  /** The write credential of the current session, minted when it is admitted. */
  private session: string | undefined;
  /**
   * Whether the last thing said about the disk was "it does not validate". While
   * it is set, the next validating snapshot is announced even if it changed
   * nothing, so a retracted invalid state cannot stay on screen.
   */
  private reportedInvalid = false;
  /**
   * The `projectInvalid` payload the current session has already been sent, so
   * an unchanged one is not sent again.
   *
   * A project stays broken for as long as it takes someone to fix it, and the
   * idle re-scan runs every few seconds throughout. Saying so once is
   * information; saying so on a timer is a stream the client has to learn to
   * ignore, and it drowns the frame that actually carries news — the moment the
   * diagnostics change, or the project comes back.
   *
   * Cleared on every transition that makes the same payload news again: a
   * validating scan, a served snapshot, and a new editor session, which has by
   * definition not been told anything yet.
   */
  private announcedInvalid: string | undefined;
  /**
   * Set when the current session asked to be caught up — it arrived holding an
   * inventory that is not the one established here — and has not been. The next
   * validating snapshot is then sent in full rather than as a diff. Retained
   * across invalid states so that a reconnect landing mid-edit still gets its
   * catch-up when the edit finishes, rather than a diff against a state it never
   * had.
   */
  private owedFullSnapshot = false;
  private closed = false;

  constructor(private readonly options: ProjectSyncOptions) {
    this.log = options.log ?? (() => {});
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.seed();
    if (options.watchFilesystem ?? true) {
      this.watcher = new DirectoryWatcher({
        root: options.mount.root,
        onSettle: () => this.scan(),
        onError: (message) => this.log(`watch ${options.mount.name}: ${message}`),
        ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
        ...(options.maxSettleMs === undefined ? {} : { maxSettleMs: options.maxSettleMs }),
        ...(options.rescanMs === undefined ? {} : { rescanMs: options.rescanMs }),
      });
    }
  }

  /** True while a browser holds this project's read-write session. */
  get hasEditor(): boolean {
    return this.editor !== undefined && this.editor.isOpen;
  }

  /**
   * Whether `session` is the credential of the browser that currently holds this
   * project's read-write session (PLAN.md §12).
   *
   * The write endpoint asks this before it touches the disk. Without it,
   * single-writer is enforced only at the socket, and a window that was *told* the
   * project is open elsewhere can still POST a write: refusing the socket takes
   * away the pushes, not the writing. Constant-time because it costs nothing.
   */
  holdsSession(session: string): boolean {
    return this.hasEditor && this.session !== undefined && constantTimeEquals(session, this.session);
  }

  /**
   * Take over a freshly upgraded socket.
   *
   * Nothing is trusted yet: the socket is unauthenticated, and stays that way
   * until a well-formed `hello` carrying the session token arrives inside
   * `HELLO_TIMEOUT_MS` (PLAN.md §10 — first-message authentication, so the token
   * never appears in a URL). Any other message, before or after the handshake,
   * closes the socket.
   */
  attach(connection: WebSocketConnection): void {
    let authenticated = false;
    const timeout = setTimeout(
      () => {
        if (!authenticated) connection.close(CLOSE_POLICY_VIOLATION, "no hello message; closing");
      },
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );
    timeout.unref();

    connection.on({
      message: (text) => {
        if (authenticated) {
          // The protocol is one-way after the handshake. An unknown message type
          // is refused rather than ignored (PLAN.md §10).
          this.refuse(connection, CLOSE_PROTOCOL_ERROR, "this protocol accepts no messages after \"hello\"");
          return;
        }
        const outcome = this.readHello(text);
        if ("refusal" in outcome) {
          this.refuse(connection, outcome.refusal.close, outcome.refusal.reason, outcome.refusal.code);
          return;
        }
        if (this.hasEditor) {
          // PLAN.md §12: one read-write UI session per project. The second
          // browser is told why rather than silently made a spectator.
          this.refuse(
            connection,
            CLOSE_ALREADY_OPEN,
            `project "${this.options.mount.name}" is open in another window`,
            "alreadyOpen",
          );
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        this.editor = connection;
        this.session = randomBytes(16).toString("hex");
        // A new page has been told nothing, so a still-broken project is news to
        // it even if the previous session had already heard it.
        this.announcedInvalid = undefined;
        connection.startKeepalive(this.keepaliveMs, this.pongTimeoutMs);
        this.send(connection, {
          type: "welcome",
          protocol: SYNC_PROTOCOL,
          project: this.options.mount.name,
          session: this.session,
        });
        this.log(`sync ${this.options.mount.name}: editor session opened`);
        this.catchUpSamples(outcome.hello.samples);
        this.catchUp(outcome.hello.inventory);
      },
      closed: (reason) => {
        clearTimeout(timeout);
        if (this.editor === connection) {
          this.editor = undefined;
          this.session = undefined;
          // Whatever this session was owed dies with it: the next one states what
          // it holds in its own hello.
          this.owedFullSnapshot = false;
          this.log(`sync ${this.options.mount.name}: editor session ended (${reason})`);
        }
      },
    });
  }

  /**
   * Record bytes this sidecar just wrote, so the watcher recognises the echo.
   *
   * Must be called in the same synchronous block as the write itself — which is
   * why `writeBatch` calls it rather than the route handler. A filesystem event
   * cannot be delivered mid-block, so there is no window in which the watcher
   * could scan a file this server has written but not yet established.
   */
  noteWrite(path: string, contents: string): void {
    if (couldBeSample(path)) {
      // Unreachable today: the write endpoint's path resolution admits documents only.
      // It is a guard rather than a comment because the day sample writing is added,
      // "documents are established as text, samples as a content hash" is precisely the
      // distinction that would be forgotten — and the symptom would be the sidecar
      // announcing its own write as an external change, on a path where the browser
      // then re-fetches bytes it just sent. Failing here makes that omission
      // impossible to ship instead of subtle to find.
      throw new Error(
        `cannot establish sample "${path}" as document text; a sample write must establish the content hash of its bytes`,
      );
    }
    this.established.set(path, contents);
  }

  /**
   * Record a document this sidecar just removed on the UI's behalf, for exactly
   * the reason `noteWrite` records one it wrote.
   *
   * Forgetting this would not lose data, but it would produce a `projectChanged`
   * naming the removal back to the window that asked for it — a push the browser
   * has to reconcile against a model it has already moved past, and the same
   * class of self-inflicted round trip echo detection exists to stop.
   */
  noteRemoval(path: string): void {
    this.established.delete(path);
  }

  /**
   * Record bytes this sidecar just served to the session holder as a whole-project
   * snapshot, for the same reason `noteWrite` records bytes it wrote: the browser
   * now has them, so re-announcing them would be a push with nothing in it.
   *
   * Only ever called for the holder of the read-write session, and only for a
   * snapshot that validated. A snapshot served to anything else — the engine
   * harness, a second window that was refused, `curl` — must not advance this, or
   * that read would swallow the editor's next push and lose an agent's edit.
   *
   * Synchronous with the response for the same reason as `noteWrite`: no
   * filesystem event can be delivered mid-block, so there is no window in which a
   * scan could see bytes that were served but not yet established.
   *
   * Samples are untouched, because the snapshot carries none: the page fetches those
   * separately, and whatever it gets is hashed from the bytes that arrive. If the disk
   * moved between this read and that fetch, the next scan announces a difference the
   * page has already picked up, and the page's own content comparison makes that a
   * no-op rather than a re-fetch.
   */
  noteServed(documents: readonly { path: string; text: string }[]): void {
    this.established.clear();
    for (const document of documents) this.established.set(document.path, document.text);
    // The holder has just read the whole project from disk, so it is caught up by
    // definition and nothing about an earlier invalid state is still on its screen.
    this.owedFullSnapshot = false;
    this.reportedInvalid = false;
    this.announcedInvalid = undefined;
  }

  /**
   * Deliver what a reconnecting page missed (PLAN.md §12).
   *
   * `inventory` is what the page says it holds. A page with nothing sends none, and
   * loads over HTTP instead. A page whose inventory is the one established here
   * missed nothing while it was away — the sidecar announces differences from what
   * it established, and that is what this page has. Anything else means the disk
   * moved without this page hearing about it, and only a full snapshot can say how:
   * the sidecar keeps no history, and a diff against a state the page never had is
   * how a browser ends up holding a model that never existed on disk.
   */
  private catchUp(inventory: string | undefined): void {
    if (inventory === undefined) return;
    if (inventory === this.establishedInventory()) {
      this.log(`sync ${this.options.mount.name}: session reconnected in step with the disk`);
      return;
    }
    this.log(`sync ${this.options.mount.name}: session reconnected behind the disk; sending a full snapshot`);
    this.owedFullSnapshot = true;
    // Sent now if the disk validates; if it does not, the flag keeps it owed and
    // the next validating scan pays it.
    this.scan();
  }

  /**
   * Tell a reconnecting page about sample content it is holding a stale copy of.
   *
   * The document `inventory` cannot answer this. A sample replaced while the socket
   * was down is established with nobody listening, so the page's *documents* can be
   * exactly in step with the disk — the quiet path through `catchUp` — while its
   * audio is a version behind. Without this, the one case the whole sample-watching
   * exercise exists for survives a reconnect.
   *
   * Answered from `establishedSamples` rather than by reading the disk: it is what
   * this sidecar knows, the next scan corrects it within one idle interval at worst,
   * and an admitted socket should not have to wait on a pass over every sample file.
   * A page that declares nothing gets nothing, because whatever it fetches later will
   * be whatever is on disk then.
   */
  private catchUpSamples(declared: readonly SampleFile[] | undefined): void {
    if (declared === undefined || declared.length === 0) return;
    const changed = declared
      .filter((sample) => {
        const established = this.establishedSamples.get(sample.path);
        // A path this sidecar has never established says nothing about staleness, so
        // it is not claimed to have changed; the page keeps what it has until a scan
        // has something to say about it.
        return established !== undefined && established !== sample.contentHash;
      })
      .map((sample) => sample.path);
    if (changed.length === 0) return;
    this.log(`sync ${this.options.mount.name}: session reconnected holding stale samples — ${changed.join(", ")}`);
    this.broadcast({
      type: "samplesChanged",
      samples: [...this.establishedSamples].map(([path, contentHash]) => ({ path, contentHash })),
      changed,
    });
  }

  /** The inventory hash of what this sidecar has established, for `catchUp`. */
  private establishedInventory(): string {
    return inventoryHash(
      [...this.established].map(([path, text]) => ({ path, contentHash: hashContent(Buffer.from(text, "utf8")) })),
    );
  }

  /**
   * Read the project, decide what changed, and push it. Called by the watcher
   * after a settle window, and directly by tests.
   */
  scan(): void {
    if (this.closed) return;
    let result: ReturnType<typeof loadProject>;
    try {
      result = loadProject(this.options.mount.root);
    } catch (error) {
      // A project directory that cannot be read at all is not a state to guess
      // about; it is reported and the last good model stays where it is.
      this.reportInvalid([
        {
          severity: "error",
          code: "project.unreadable",
          file: "",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
      return;
    }

    const diagnostics = result.diagnostics.map(toApiDiagnostic);
    if (!result.ok || result.project === undefined) {
      // Where an invalid *sample* lands, too, and deliberately by the same route: a
      // replaced file that is not PCM WAV, is over the cap, or has been deleted while
      // a kit voice still names it fails `semanticValidate`, so it arrives here as an
      // invalid project. The last good audio keeps playing, the diagnostic names the
      // file, and `establishedSamples` is untouched — so when the file is fixed, the
      // difference is still there to announce.
      // Transient invalid states are expected mid-edit, so this is not an error
      // to recover from — it is a state to report and wait out. `established` is
      // untouched, so nothing here is consumed. This is also where a deletion that
      // breaks the project lands, which is why nothing below it treats a missing
      // file as a special case.
      this.log(`sync ${this.options.mount.name}: disk does not validate; holding the last snapshot`);
      this.reportInvalid(diagnostics);
      return;
    }

    // Before the documents, because the two can change together and a graph naming
    // sample content the worklet has not been sent is refused by the worklet. Ordering
    // it this way means a document edit that adds a kit voice pointing at a file that
    // was *also* replaced finds the new content already on its way.
    if (!this.scanSamples(result.project)) return;

    const full = this.owedFullSnapshot;
    const changed: SnapshotDocument[] = [];
    const files: SnapshotFile[] = [];
    for (const file of result.files.values()) {
      const contentHash = hashContent(Buffer.from(file.text, "utf8"));
      files.push({ path: file.path, kind: file.kind, contentHash });
      if (full || this.established.get(file.path) !== file.text) {
        changed.push({ path: file.path, kind: file.kind, contentHash, text: file.text });
      }
    }
    const removed = [...this.established.keys()].filter((path) => !result.files.has(path)).sort();

    if (!full && !this.reportedInvalid && changed.length === 0 && removed.length === 0) {
      // Every byte on disk is a byte we put there or already announced, and every
      // document we knew about is still there: this was our own echo, an event that
      // changed nothing, or a file that vanished and came back unchanged.
      return;
    }

    for (const file of changed) this.established.set(file.path, file.text);
    for (const path of removed) this.established.delete(path);

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.log(
      `sync ${this.options.mount.name}: ${full ? "full snapshot" : "external edit"} — changed ${
        changed.map((file) => file.path).join(", ") || "none"
      }${removed.length > 0 ? `, removed ${removed.join(", ")}` : ""}`,
    );
    this.reportedInvalid = false;
    this.announcedInvalid = undefined;
    this.owedFullSnapshot = false;
    this.broadcast({ type: "projectChanged", scope: full ? "full" : "diff", files, changed, removed, diagnostics });
  }

  /**
   * Hash the project's referenced samples, announce the ones whose content moved,
   * and establish them. Returns false when the samples could not be read, having
   * reported that instead.
   *
   * Called on every scan, including the idle re-scan, and it reads every referenced
   * sample to do it. That is the cost of content being the identity, and it is not a
   * new cost: `semanticValidate` already reads each of them to check its WAV header,
   * so a scan was O(all sample bytes) before this existed. If a project ever holds
   * enough audio for that to matter, the fix is to hash during the load that is
   * already reading the bytes — not to start trusting mtimes.
   */
  private scanSamples(project: Project): boolean {
    const samples: SampleFile[] = [];
    for (const path of referencedSamplePaths(project)) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(this.options.mount.root, path));
      } catch (error) {
        // The project validated a moment ago, so this is a file that vanished between
        // that read and this one. Reported rather than skipped: a sample this sidecar
        // cannot read is one whose content it cannot vouch for, and quietly leaving it
        // out of the inventory is how a page keeps playing audio the disk no longer has.
        this.reportInvalid([
          {
            severity: "error",
            code: "sample.unreadable",
            file: path,
            message: `sample "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
        return false;
      }
      samples.push({ path, contentHash: hashContent(bytes) });
    }

    const changed = samples
      .filter((sample) => this.establishedSamples.get(sample.path) !== sample.contentHash)
      .map((sample) => sample.path);
    for (const sample of samples) this.establishedSamples.set(sample.path, sample.contentHash);
    if (changed.length === 0) return true;

    this.log(`sync ${this.options.mount.name}: samples changed — ${changed.join(", ")}`);
    this.broadcast({ type: "samplesChanged", samples, changed });
    return true;
  }

  /**
   * Say that the disk does not currently validate, and remember having said it.
   *
   * The remembering is what makes a retraction possible: if the disk returns to
   * exactly the bytes already established — a delete-then-recreate, a broken edit
   * reverted — there is no content difference left to report, and without this flag
   * the UI would keep showing an error about a state that no longer exists.
   */
  private reportInvalid(diagnostics: ApiDiagnostic[]): void {
    this.reportedInvalid = true;
    const message: ServerMessage = { type: "projectInvalid", diagnostics };
    // Compared on the serialized frame, which is exactly what the client would
    // receive: two scans of an unchanged broken file produce equal diagnostics,
    // and a repeat of a frame carries no information a client could act on.
    const announced = JSON.stringify(message);
    if (announced === this.announcedInvalid) return;
    this.announcedInvalid = announced;
    this.broadcast(message);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.editor?.close(CLOSE_GOING_AWAY, "sidecar shutting down");
    this.editor = undefined;
    this.session = undefined;
  }

  /** What the sidecar believes is on disk. For tests and diagnostics. */
  establishedText(path: string): string | undefined {
    return this.established.get(path);
  }

  /** The content hash the sidecar believes a sample holds. For tests and diagnostics. */
  establishedSampleHash(path: string): string | undefined {
    return this.establishedSamples.get(path);
  }

  /**
   * Validate a `hello`, returning the message itself when it is acceptable. Every
   * refusal names its own reason: a page that cannot connect must be able to say why.
   */
  private readHello(text: string): { hello: HelloMessage } | { refusal: Refusal } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { refusal: { close: CLOSE_PROTOCOL_ERROR, reason: `first message is not JSON: ${String(error)}` } };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { refusal: { close: CLOSE_PROTOCOL_ERROR, reason: "first message must be a JSON object" } };
    }
    const message = parsed as Record<string, unknown>;
    if (message["type"] !== "hello") {
      return {
        refusal: {
          close: CLOSE_PROTOCOL_ERROR,
          reason: `expected a "hello" message, got ${JSON.stringify(message["type"])}`,
        },
      };
    }
    if (message["protocol"] !== SYNC_PROTOCOL) {
      return {
        refusal: {
          close: CLOSE_POLICY_VIOLATION,
          reason: `this page speaks sync protocol ${JSON.stringify(message["protocol"])} and the sidecar speaks ${SYNC_PROTOCOL}; reload the page`,
          code: "protocol",
        },
      };
    }
    const token = message["token"];
    if (typeof token !== "string" || !constantTimeEquals(token, this.options.token)) {
      // Deliberately not phrased as a security failure. The token is minted per run,
      // so much the commonest cause of this is that the sidecar was restarted while
      // this page stayed open — and telling a person their routine restart is an
      // authentication problem, while throwing away the edits they had not written
      // yet, is wrong twice over. `staleToken` lets the page fetch the current token
      // and hand the handshake back with everything it holds intact.
      return {
        refusal: {
          close: CLOSE_UNAUTHORIZED,
          reason:
            "this page's session token is not the one the sidecar is using; if the sidecar has been restarted, reconnecting with the current token will fix it",
          code: "staleToken",
        },
      };
    }
    const project = message["project"];
    if (project !== this.options.mount.name) {
      return {
        refusal: {
          close: CLOSE_POLICY_VIOLATION,
          reason: `this socket is for project "${this.options.mount.name}", not ${JSON.stringify(project)}`,
          code: "protocol",
        },
      };
    }
    const inventory = message["inventory"];
    if (inventory !== undefined && typeof inventory !== "string") {
      return {
        refusal: {
          close: CLOSE_PROTOCOL_ERROR,
          reason: `"inventory" must be a string if present, got ${JSON.stringify(inventory)}`,
        },
      };
    }
    const samples = readDeclaredSamples(message["samples"]);
    if ("refusal" in samples) return samples;
    return {
      hello: {
        type: "hello",
        protocol: SYNC_PROTOCOL,
        token,
        project,
        ...(inventory === undefined ? {} : { inventory }),
        ...(samples.samples === undefined ? {} : { samples: samples.samples }),
      },
    };
  }

  private refuse(connection: WebSocketConnection, close: number, reason: string, code?: RejectionCode): void {
    this.log(`sync ${this.options.mount.name}: refusing socket — ${reason}`);
    this.send(connection, code === undefined ? { type: "error", message: reason } : { type: "rejected", code, reason });
    connection.close(close, reason);
  }

  private broadcast(message: ServerMessage): void {
    if (this.editor === undefined || !this.editor.isOpen) return;
    this.send(this.editor, message);
  }

  private send(connection: WebSocketConnection, message: ServerMessage): void {
    connection.sendText(JSON.stringify(message));
  }

  /**
   * Establish the project's current state at startup, so the first external edit
   * is reported as a diff rather than as "every file changed".
   *
   * An invalid project is left unestablished on purpose: there is no valid
   * snapshot to be the baseline, and the browser's own per-file check makes the
   * resulting first full announcement harmless.
   */
  private seed(): void {
    try {
      const result = loadProject(this.options.mount.root);
      if (!result.ok) {
        this.log(`sync ${this.options.mount.name}: project does not validate at startup; watching anyway`);
        return;
      }
      for (const file of result.files.values()) this.established.set(file.path, file.text);
      if (result.project !== undefined) {
        for (const path of referencedSamplePaths(result.project)) {
          try {
            this.establishedSamples.set(path, hashContent(readFileSync(join(this.options.mount.root, path))));
          } catch (error) {
            // A sample the project validated against and yet cannot be read now is a
            // startup race, not a state to establish. Left unestablished, so the first
            // scan announces it.
            this.log(`sync ${this.options.mount.name}: could not hash sample ${path} at startup: ${String(error)}`);
          }
        }
      }
    } catch (error) {
      this.log(`sync ${this.options.mount.name}: could not read the project at startup: ${String(error)}`);
    }
  }
}

/**
 * Read the optional sample inventory out of a `hello`.
 *
 * Malformed is refused rather than ignored: a page whose declaration this sidecar
 * silently dropped would be told nothing about its stale audio, which is the exact
 * failure the field exists to prevent — so it must not be possible to half-send it.
 */
function readDeclaredSamples(
  value: unknown,
): { samples: SampleFile[] | undefined } | { refusal: Refusal } {
  if (value === undefined) return { samples: undefined };
  if (!Array.isArray(value)) {
    return {
      refusal: {
        close: CLOSE_PROTOCOL_ERROR,
        reason: `"samples" must be an array if present, got ${JSON.stringify(value)}`,
      },
    };
  }
  const samples: SampleFile[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object") {
      return { refusal: { close: CLOSE_PROTOCOL_ERROR, reason: `every "samples" entry must be an object, got ${JSON.stringify(entry)}` } };
    }
    const { path, contentHash } = entry as { path?: unknown; contentHash?: unknown };
    if (typeof path !== "string" || typeof contentHash !== "string") {
      return {
        refusal: {
          close: CLOSE_PROTOCOL_ERROR,
          reason: `every "samples" entry needs a string "path" and "contentHash", got ${JSON.stringify(entry)}`,
        },
      };
    }
    samples.push({ path, contentHash });
  }
  return { samples };
}

/**
 * Why a socket is being closed, and what to tell it first.
 *
 * A `code` accompanies every `rejected` refusal because the page has to tell a
 * restarted sidecar from a window it will never admit, and prose is the wrong thing
 * to decide that on.
 */
interface Refusal {
  close: number;
  reason: string;
  code?: RejectionCode;
}

function toApiDiagnostic(diagnostic: { severity: string; code: string; file: string; message: string }): ApiDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    file: diagnostic.file,
    message: diagnostic.message,
  };
}
