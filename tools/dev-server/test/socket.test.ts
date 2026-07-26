import { describe, expect, it } from "vitest";
import {
  CLOSE_ALREADY_OPEN,
  SYNC_PROTOCOL,
  type HelloMessage,
  type ProjectChangedMessage,
  type ProjectInvalidMessage,
  type ServerMessage,
} from "../src/api.js";
import { ProjectSocket, type SyncRejection, type SyncTransportHandlers } from "../src/socket.js";

/**
 * The browser's half of the sync protocol, without a browser or a server.
 *
 * `sync.test.ts` drives this class over a real socket against the real sidecar,
 * which is the right way to test the protocol as a whole. What it cannot easily do
 * is force the *page's* side of a reconnect — a dropped connection, what the second
 * hello says, what happens to the write session when the socket goes. Those are the
 * cases here, driven through a transport the test owns entirely.
 */

const TOKEN = "socket-token-0123456789abcdef";

/** A transport whose every event the test triggers by hand. */
class FakeTransport {
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly handlers: SyncTransportHandlers) {}

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  /** The hellos this transport was asked to send, parsed. */
  get hellos(): HelloMessage[] {
    return this.sent.map((text) => JSON.parse(text) as HelloMessage);
  }

  deliver(message: ServerMessage): void {
    this.handlers.text(JSON.stringify(message));
  }
}

interface Harness {
  socket: ProjectSocket;
  transports: FakeTransport[];
  ready: boolean[];
  changed: ProjectChangedMessage[];
  invalid: ProjectInvalidMessage[];
  rejected: SyncRejection[];
  dropped: string[];
  protocolErrors: string[];
  /** Retry timers the socket armed, so a reconnect happens when the test says so. */
  timers: (() => void)[];
  runTimers(): void;
  latest(): FakeTransport;
}

function harness(options: { inventory?: () => string | undefined } = {}): Harness {
  const transports: FakeTransport[] = [];
  const timers: (() => void)[] = [];
  const state = {
    ready: [] as boolean[],
    changed: [] as ProjectChangedMessage[],
    invalid: [] as ProjectInvalidMessage[],
    rejected: [] as SyncRejection[],
    dropped: [] as string[],
    protocolErrors: [] as string[],
  };
  const socket = new ProjectSocket({
    project: "p",
    token: TOKEN,
    ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
    factory: (_path, handlers) => {
      const transport = new FakeTransport(handlers);
      transports.push(transport);
      return transport;
    },
    handlers: {
      ready: (reconnected) => state.ready.push(reconnected),
      changed: (message) => state.changed.push(message),
      invalid: (message) => state.invalid.push(message),
      rejected: (rejection) => state.rejected.push(rejection),
      dropped: (reason) => state.dropped.push(reason),
      protocolError: (message) => state.protocolErrors.push(message),
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer: () => {},
  });
  return {
    socket,
    transports,
    timers,
    runTimers: () => {
      for (const callback of timers.splice(0)) callback();
    },
    latest: () => {
      const transport = transports[transports.length - 1];
      if (transport === undefined) throw new Error("no transport has been opened");
      return transport;
    },
    get ready() {
      return state.ready;
    },
    get changed() {
      return state.changed;
    },
    get invalid() {
      return state.invalid;
    },
    get rejected() {
      return state.rejected;
    },
    get dropped() {
      return state.dropped;
    },
    get protocolErrors() {
      return state.protocolErrors;
    },
  };
}

function welcome(session = "session-one"): ServerMessage {
  return { type: "welcome", protocol: SYNC_PROTOCOL, project: "p", session };
}

/** Open the socket and complete the handshake. */
function connect(test: Harness, session?: string): FakeTransport {
  test.socket.connect();
  const transport = test.latest();
  transport.handlers.open();
  transport.deliver(welcome(session));
  return transport;
}

describe("the write session", () => {
  it("takes the session id from the welcome", () => {
    const test = harness();

    connect(test, "abc123");

    expect(test.socket.session).toBe("abc123");
    expect(test.ready).toEqual([false]);
  });

  it("gives up the session when the connection drops, and takes the new one on reconnect", () => {
    const test = harness();
    connect(test, "first");

    test.latest().handlers.closed(1006, "gone");

    // Nothing may be written while there is no session: the sidecar has retired
    // this one, and presenting it would be refused anyway.
    expect(test.socket.session).toBeUndefined();
    expect(test.dropped).toHaveLength(1);

    test.runTimers();
    const second = test.latest();
    second.handlers.open();
    second.deliver(welcome("second"));

    expect(test.socket.session).toBe("second");
    expect(test.ready).toEqual([false, true]);
  });

  it("holds no session after a refusal", () => {
    const test = harness();
    test.socket.connect();
    const transport = test.latest();
    transport.handlers.open();

    transport.deliver({ type: "rejected", reason: 'project "p" is open in another window' });
    transport.handlers.closed(CLOSE_ALREADY_OPEN, "already open");

    expect(test.socket.session).toBeUndefined();
    expect(test.rejected).toEqual([{ kind: "alreadyOpen", message: 'project "p" is open in another window' }]);
    // A second window does not retry: it would be fighting the first for the project.
    expect(test.timers).toEqual([]);
  });

  it("refuses a welcome that carries no session, rather than running without one", () => {
    const test = harness();
    test.socket.connect();
    const transport = test.latest();
    transport.handlers.open();

    transport.deliver({ type: "welcome", protocol: SYNC_PROTOCOL, project: "p" } as unknown as ServerMessage);

    expect(test.ready).toEqual([]);
    expect(test.rejected[0]?.kind).toBe("refused");
    expect(test.rejected[0]?.message).toContain("session");
    expect(test.socket.session).toBeUndefined();
  });
});

describe("telling the sidecar what this page holds", () => {
  it("sends no inventory when the page holds nothing", () => {
    const test = harness({ inventory: () => undefined });

    connect(test);

    expect(test.latest().hellos[0]).toEqual({
      type: "hello",
      protocol: SYNC_PROTOCOL,
      token: TOKEN,
      project: "p",
    });
  });

  it("sends the page's current inventory on a reconnect, read at connect time", () => {
    // Read at connect time and not once at construction, because the answer is "the
    // disk state this page is caught up to *now*". A stale value would ask the
    // sidecar to replay from the wrong point.
    let inventory: string | undefined;
    const test = harness({ inventory: () => inventory });
    connect(test);
    expect(test.latest().hellos[0]?.inventory).toBeUndefined();

    inventory = "inventory-after-the-load";
    test.latest().handlers.closed(1006, "gone");
    test.runTimers();
    const second = test.latest();
    second.handlers.open();

    expect(second.hellos[0]?.inventory).toBe("inventory-after-the-load");
  });
});

describe("messages it cannot act on", () => {
  it("passes a diff and a full snapshot through, and says which it was", () => {
    const test = harness();
    const transport = connect(test);
    const base = { type: "projectChanged" as const, files: [], changed: [], removed: [], diagnostics: [] };

    transport.deliver({ ...base, scope: "diff" });
    transport.deliver({ ...base, scope: "full" });

    expect(test.changed.map((message) => message.scope)).toEqual(["diff", "full"]);
    expect(test.protocolErrors).toEqual([]);
  });

  it("refuses a projectChanged that does not say what it carries", () => {
    // The scopes need opposite treatment of a file the inventory does not name — a
    // removal, or evidence of a desync — so a message without one cannot be applied
    // at all, and applying it as a guess would either lose a file or claim a desync.
    const test = harness();
    const transport = connect(test);

    transport.deliver({
      type: "projectChanged",
      files: [],
      changed: [],
      removed: [],
      diagnostics: [],
    } as unknown as ServerMessage);

    expect(test.changed).toEqual([]);
    expect(test.protocolErrors[0]).toContain("whole project");
  });

  it("refuses a projectChanged with missing lists, and an unknown message type", () => {
    const test = harness();
    const transport = connect(test);

    transport.deliver({ type: "projectChanged", scope: "diff" } as unknown as ServerMessage);
    transport.deliver({ type: "somethingNewer" } as unknown as ServerMessage);

    expect(test.protocolErrors).toHaveLength(2);
    expect(test.protocolErrors[0]).toContain("file lists");
    expect(test.protocolErrors[1]).toContain("somethingNewer");
  });

  it("reports a protocol version mismatch as a refusal and stops", () => {
    const test = harness();
    test.socket.connect();
    const transport = test.latest();
    transport.handlers.open();

    transport.deliver({ type: "welcome", protocol: SYNC_PROTOCOL + 1, project: "p", session: "x" });

    expect(test.rejected[0]?.message).toContain("reload");
    expect(transport.closed).toBe(true);
    expect(test.socket.session).toBeUndefined();
  });
});
