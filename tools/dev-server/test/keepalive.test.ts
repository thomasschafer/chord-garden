import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_PROTOCOL } from "../src/api.js";
import { KEEPALIVE_MS, PONG_TIMEOUT_MS, ProjectSync } from "../src/sync.js";
import { CLOSE_GOING_AWAY, WebSocketConnection } from "../src/websocket.js";
import { clientFrame, clientText, FakeSocket } from "./helpers.js";

/**
 * A browser that dies without a close frame (PLAN.md §12, single-writer).
 *
 * A crashed tab, a killed renderer, a laptop that suspended mid-edit: the TCP
 * connection is not closed, so nothing tells the sidecar the session is over, and
 * the project's one write slot stays held. The human who reopens their own project
 * is then told it "is open in another window" — naming a window that no longer
 * exists — and can do nothing but wait. Ping/pong is the only thing that ends that
 * wait, so how long it takes is a product property rather than an implementation
 * detail, and it is what these tests pin.
 *
 * Driven on a fake clock against a fake socket. The alternative is to wait out real
 * seconds and hope the machine is not busy, which is how a timing test becomes the
 * flakiest thing in a suite; here the schedule is exact and the test is instant.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(REPO_ROOT, "fixtures/valid/first-track");
const TOKEN = "keepalive-token-0123456789abcdef";
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const OPCODE_CLOSE = 0x8;

/** A short, exact schedule for the fake clock; the shipped values are asserted separately. */
const PING_MS = 200;
const PONG_MS = 100;

let root: string;

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "chord-garden-keepalive-"));
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** A pong, as a browser's WebSocket implementation answers a ping. */
function pong(): Buffer {
  return clientFrame(OPCODE_PONG, Buffer.alloc(0));
}

/**
 * Split what the connection wrote back into frames.
 *
 * Server frames are never masked and carry their length in one of three forms, so
 * this is short — but it has to be done rather than assumed, because a `welcome` is
 * over 125 bytes and therefore has a wider header than a ping does.
 */
function serverFrames(socket: FakeSocket): { opcode: number; payload: Buffer }[] {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let rest = Buffer.concat(socket.sent);
  while (rest.length >= 2) {
    const opcode = rest[0]! & 0x0f;
    const short = rest[1]! & 0x7f;
    let length = short;
    let offset = 2;
    if (short === 126) {
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (short === 127) {
      length = rest.readUInt32BE(6);
      offset = 10;
    }
    if (rest.length < offset + length) break;
    frames.push({ opcode, payload: rest.subarray(offset, offset + length) });
    rest = rest.subarray(offset + length);
  }
  return frames;
}

function opcodes(socket: FakeSocket): number[] {
  return serverFrames(socket).map((frame) => frame.opcode);
}

/** Every text message the connection has sent, parsed. */
function messages(socket: FakeSocket): { type: string }[] {
  return serverFrames(socket)
    .filter((frame) => frame.opcode === 0x1)
    .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { type: string });
}

/**
 * A live connection over a fake socket.
 *
 * The `advanceTimersByTimeAsync(0)` is not decoration: a `Duplex` only starts
 * emitting `data` after the `resume` it schedules on the next tick has run, and a
 * fully synchronous test body never lets that happen — so a pong pushed before it
 * would be delivered after the deadline had already fired, and the test would be
 * asserting the opposite of what it looks like it asserts.
 */
async function connected(pingMs: number, pongMs: number): Promise<{ socket: FakeSocket; connection: WebSocketConnection }> {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, 64 * 1024);
  connection.startKeepalive(pingMs, pongMs);
  await vi.advanceTimersByTimeAsync(0);
  return { socket, connection };
}

describe("the ping deadline that reaps a dead peer", () => {
  it("bounds the wait at one ping interval plus one pong deadline", async () => {
    const { socket, connection } = await connected(PING_MS, PONG_MS);
    let closedWith: string | undefined;
    connection.on({ closed: (reason) => (closedWith = reason) });

    // The worst case is a peer that dies the instant after answering: it has a whole
    // interval before anything asks it another question. When the deadline for a
    // reply *was* the interval, that cost two full intervals — the thing this splits.
    await vi.advanceTimersByTimeAsync(PING_MS);
    socket.receive(pong());
    await vi.advanceTimersByTimeAsync(PING_MS - 1);
    expect(connection.isOpen).toBe(true);

    // The next ping goes out, and this peer is already gone.
    await vi.advanceTimersByTimeAsync(1);
    expect(opcodes(socket).filter((opcode) => opcode === OPCODE_PING)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PONG_MS - 1);
    expect(connection.isOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(connection.isOpen).toBe(false);
    expect(closedWith).toContain("no pong");
    // Closed properly rather than dropped, so a far end that is listening after all
    // is told why instead of seeing a bare disconnect.
    const close = serverFrames(socket).find((frame) => frame.opcode === OPCODE_CLOSE);
    expect(close?.payload.readUInt16BE(0)).toBe(CLOSE_GOING_AWAY);
  });

  it("never closes a peer that keeps answering, however late in the window it answers", async () => {
    const { socket, connection } = await connected(PING_MS, PONG_MS);

    // A healthy client that is slow: every pong arrives at the last possible moment,
    // ten rounds running. Being slow costs it nothing — only being absent does.
    //
    // Driven from absolute times rather than by advancing a fixed step each round,
    // because the interval keeps its own phase: answering a ping early does not move
    // the next one, so "advance one interval" drifts out of step with the schedule
    // after the first round and starts landing exactly on a deadline.
    let now = 0;
    const advanceTo = async (time: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(time - now);
      now = time;
    };
    for (let round = 1; round <= 10; round++) {
      await advanceTo(round * PING_MS);
      await advanceTo(round * PING_MS + PONG_MS - 1);
      expect(connection.isOpen).toBe(true);
      socket.receive(pong());
      await advanceTo(round * PING_MS + PONG_MS);
      expect(connection.isOpen).toBe(true);
    }

    expect(opcodes(socket).filter((opcode) => opcode === OPCODE_PING)).toHaveLength(10);
    expect(opcodes(socket)).not.toContain(OPCODE_CLOSE);
  });

  it("does not pile up pings while one is still outstanding", async () => {
    // The interval and the deadline are independent timers now, so an interval
    // shorter than the deadline could otherwise send a second ping whose own
    // deadline restarts the wait — and a dead peer would be held indefinitely by
    // the very mechanism meant to reap it.
    const { socket, connection } = await connected(100, 350);

    // The first ping goes out at 100 and its deadline expires at 450. Four more
    // interval ticks pass in between, and not one of them may send a ping.
    await vi.advanceTimersByTimeAsync(449);
    expect(opcodes(socket).filter((opcode) => opcode === OPCODE_PING)).toHaveLength(1);
    expect(connection.isOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(connection.isOpen).toBe(false);
  });
});

describe("the single-writer session a dead browser was holding", () => {
  /** Attach a socket to a sync and complete the handshake. */
  function connect(sync: ProjectSync): FakeSocket {
    const socket = new FakeSocket();
    const connection = new WebSocketConnection(socket, 64 * 1024);
    sync.attach(connection);
    connection.ingest(
      clientText(JSON.stringify({ type: "hello", protocol: SYNC_PROTOCOL, token: TOKEN, project: "p" })),
    );
    return socket;
  }

  it("is released without a close frame, and the next window is admitted", async () => {
    const sync = new ProjectSync({
      mount: { name: "p", root },
      token: TOKEN,
      watchFilesystem: false,
      keepaliveMs: PING_MS,
      pongTimeoutMs: PONG_MS,
    });
    try {
      const dead = connect(sync);
      expect(sync.hasEditor).toBe(true);
      expect(messages(dead).map((message) => message.type)).toEqual(["welcome"]);

      // The tab crashes. No close frame and no FIN — the socket is simply never
      // spoken on again, which is what a suspended machine looks like from here.
      await vi.advanceTimersByTimeAsync(PING_MS + PONG_MS - 1);
      expect(sync.hasEditor).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      expect(sync.hasEditor).toBe(false);
      expect(opcodes(dead)).toContain(OPCODE_CLOSE);

      // And the slot is genuinely free rather than merely reported free: the human's
      // new window gets a welcome, not "open in another window".
      const replacement = connect(sync);
      expect(sync.hasEditor).toBe(true);
      expect(messages(replacement).map((message) => message.type)).toEqual(["welcome"]);
    } finally {
      sync.close();
    }
  });

  it("waits ten seconds with the shipped intervals, not thirty", () => {
    // The numbers themselves, because they are what a person experiences. Asserted
    // against absolute values rather than against each other, so raising one of them
    // cannot quietly restore the old wait.
    expect(KEEPALIVE_MS).toBe(5_000);
    expect(PONG_TIMEOUT_MS).toBe(5_000);
    expect(KEEPALIVE_MS + PONG_TIMEOUT_MS).toBe(10_000);
  });
});
