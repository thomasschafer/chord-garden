import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The server half of RFC 6455, in the narrow shape this sidecar needs.
 *
 * Written rather than depended on, and the reasoning is worth recording because
 * "just add `ws`" is the obvious alternative. Node ships a WebSocket *client*
 * (used by this package's tests) but no server, so something has to speak the
 * framing. What this needs is small and fixed: one subprotocol-free text
 * channel, no extensions, no permessage-deflate, a hard message-size ceiling
 * (PLAN.md §10), and control over the handshake so the Host/Origin checks that
 * already guard HTTP guard the upgrade too. The risky part of a hand-rolled
 * implementation is the frame decoder, and that risk is answered the way this
 * project answers every other one (PLAN.md §18): the decoder is a pure function
 * of a byte stream, so `test/websocket.test.ts` can feed it byte-at-a-time,
 * split headers across chunks, and assert every malformed frame closes with the
 * right code — and the end-to-end tests then drive it with Node's own
 * independent client implementation. If it ever misbehaves in a way that suite
 * cannot express, swapping in `ws` behind `WebSocketConnection` is a contained
 * change.
 */

/** Magic value from RFC 6455 §1.3, concatenated with the client's key. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** RFC 6455 §7.4.1 close codes, the ones this implementation can send. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_UNSUPPORTED_DATA = 1003;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_TOO_LARGE = 1009;
export const CLOSE_INTERNAL_ERROR = 1011;

/** A complete message decoded from the stream. */
export type DecodedMessage =
  | { kind: "text"; text: string }
  | { kind: "ping"; payload: Buffer }
  | { kind: "pong" }
  | { kind: "close"; code: number | undefined; reason: string };

/** A framing rule the peer broke. The connection must close with `code`. */
export interface DecodeFailure {
  code: number;
  reason: string;
}

export type DecodeResult = { ok: true; messages: DecodedMessage[] } | { ok: false; failure: DecodeFailure };

/**
 * Incremental decoder for client→server frames.
 *
 * Deliberately strict, because this is a localhost filesystem bridge and a
 * decoder that guesses at a malformed frame is a decoder that can be steered.
 * Anything the negotiated protocol does not include — a reserved bit, an
 * extension bit, an unmasked client frame, a binary message, a fragmented
 * control frame — is a failure with a close code, never a best effort.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  /** Payload fragments of the message being assembled, if any. */
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private failed = false;

  constructor(private readonly maxMessageBytes: number) {}

  /**
   * Feed received bytes and take out whatever whole messages they completed.
   *
   * Once a failure is returned the decoder is spent: the stream's framing is no
   * longer trustworthy, so further bytes are not parsed at all.
   */
  push(chunk: Buffer): DecodeResult {
    if (this.failed) {
      return { ok: false, failure: { code: CLOSE_PROTOCOL_ERROR, reason: "frame stream already failed" } };
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: DecodedMessage[] = [];

    for (;;) {
      const frame = this.takeFrame();
      if (frame === undefined) break;
      if (!frame.ok) {
        this.failed = true;
        return frame;
      }
      const message = this.assemble(frame.frame);
      if (message !== undefined) {
        if (!message.ok) {
          this.failed = true;
          return message;
        }
        if (message.message !== undefined) messages.push(message.message);
      }
    }

    // A backstop, not the real guard: a frame that declares more than the limit
    // is refused from its header above, before any payload is buffered, and the
    // largest legitimate frame is exactly `maxMessageBytes + 14` bytes. So this
    // cannot fire unless one of those checks is later loosened — which is
    // precisely when an unbounded buffer would become reachable.
    if (this.buffer.length > this.maxMessageBytes + 14) {
      this.failed = true;
      return {
        ok: false,
        failure: { code: CLOSE_TOO_LARGE, reason: `frame exceeds the ${this.maxMessageBytes}-byte message limit` },
      };
    }
    return { ok: true, messages };
  }

  /** Pull one whole frame off the front of the buffer, if one is there. */
  private takeFrame():
    | { ok: true; frame: { opcode: number; fin: boolean; payload: Buffer } }
    | { ok: false; failure: DecodeFailure }
    | undefined {
    if (this.buffer.length < 2) return undefined;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const reserved = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (reserved !== 0) {
      return { ok: false, failure: { code: CLOSE_PROTOCOL_ERROR, reason: "reserved frame bits are set" } };
    }
    if (!masked) {
      // RFC 6455 §5.1: a client MUST mask. An unmasked frame here is not a
      // browser, and is not something to be lenient about.
      return { ok: false, failure: { code: CLOSE_PROTOCOL_ERROR, reason: "client frame is not masked" } };
    }

    const control = (opcode & 0x08) !== 0;
    if (control && (length > 125 || !fin)) {
      return {
        ok: false,
        failure: { code: CLOSE_PROTOCOL_ERROR, reason: "control frames must be short and unfragmented" },
      };
    }

    if (length === 126) {
      if (this.buffer.length < offset + 2) return undefined;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return undefined;
      const high = this.buffer.readUInt32BE(offset);
      const low = this.buffer.readUInt32BE(offset + 4);
      if (high !== 0 || low > this.maxMessageBytes) {
        return {
          ok: false,
          failure: { code: CLOSE_TOO_LARGE, reason: `frame declares more than ${this.maxMessageBytes} bytes` },
        };
      }
      length = low;
      offset += 8;
    }
    if (length > this.maxMessageBytes) {
      return {
        ok: false,
        failure: { code: CLOSE_TOO_LARGE, reason: `frame declares ${length} bytes, over the limit` },
      };
    }

    const total = offset + 4 + length;
    if (this.buffer.length < total) return undefined;
    const mask = this.buffer.subarray(offset, offset + 4);
    const masking = this.buffer.subarray(offset + 4, total);
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) {
      payload[index] = masking[index]! ^ mask[index % 4]!;
    }
    this.buffer = this.buffer.subarray(total);
    return { ok: true, frame: { opcode, fin, payload } };
  }

  /** Turn a frame into a message, joining fragments as needed. */
  private assemble(frame: { opcode: number; fin: boolean; payload: Buffer }):
    | { ok: true; message: DecodedMessage | undefined }
    | { ok: false; failure: DecodeFailure }
    | undefined {
    switch (frame.opcode) {
      case OPCODE_PING:
        return { ok: true, message: { kind: "ping", payload: frame.payload } };
      case OPCODE_PONG:
        return { ok: true, message: { kind: "pong" } };
      case OPCODE_CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : undefined;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        return { ok: true, message: { kind: "close", code, reason } };
      }
      case OPCODE_BINARY:
        return {
          ok: false,
          failure: { code: CLOSE_UNSUPPORTED_DATA, reason: "this protocol carries JSON text, not binary frames" },
        };
      case OPCODE_TEXT:
        if (this.fragments.length > 0) {
          return {
            ok: false,
            failure: { code: CLOSE_PROTOCOL_ERROR, reason: "a new message started before the previous one finished" },
          };
        }
        return this.collect(frame.payload, frame.fin);
      case OPCODE_CONTINUATION:
        if (this.fragments.length === 0) {
          return {
            ok: false,
            failure: { code: CLOSE_PROTOCOL_ERROR, reason: "continuation frame with no message in progress" },
          };
        }
        return this.collect(frame.payload, frame.fin);
      default:
        return {
          ok: false,
          failure: { code: CLOSE_PROTOCOL_ERROR, reason: `unknown frame opcode 0x${frame.opcode.toString(16)}` },
        };
    }
  }

  private collect(
    payload: Buffer,
    fin: boolean,
  ): { ok: true; message: DecodedMessage | undefined } | { ok: false; failure: DecodeFailure } {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      return {
        ok: false,
        failure: { code: CLOSE_TOO_LARGE, reason: `message is over the ${this.maxMessageBytes}-byte limit` },
      };
    }
    this.fragments.push(payload);
    if (!fin) return { ok: true, message: undefined };
    const text = Buffer.concat(this.fragments).toString("utf8");
    this.fragments = [];
    this.fragmentBytes = 0;
    return { ok: true, message: { kind: "text", text } };
  }
}

/** Frame `payload` for sending to a client: FIN set, never masked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** The `Sec-WebSocket-Accept` value for a client's key (RFC 6455 §4.2.2). */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

export interface UpgradeRefusal {
  status: number;
  message: string;
}

/**
 * Check an upgrade request and answer the handshake, or refuse it.
 *
 * `check` runs the caller's Host/Origin rules; refusing here means the socket
 * never reaches 101, so a rejected peer gets an HTTP error it can read rather
 * than a WebSocket that closes for reasons it cannot see. Authentication is
 * deliberately *not* here: PLAN.md §10 wants the token in the first message
 * rather than in a URL, so the handshake accepts and `SyncSession` closes the
 * socket if the first message is not a valid `hello`.
 */
export function acceptUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  options: { maxMessageBytes: number; check?: (req: IncomingMessage) => UpgradeRefusal | undefined },
): WebSocketConnection | undefined {
  const refusal = validateHandshake(req) ?? options.check?.(req);
  if (refusal !== undefined) {
    refuseUpgrade(socket, refusal);
    return undefined;
  }
  const key = header(req, "sec-websocket-key")!;
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n"),
  );
  return new WebSocketConnection(socket, options.maxMessageBytes);
}

/** Write an HTTP refusal to a socket that asked to be upgraded, and end it. */
export function refuseUpgrade(socket: Duplex, refusal: UpgradeRefusal): void {
  const body = Buffer.from(refusal.message, "utf8");
  socket.write(
    [
      `HTTP/1.1 ${refusal.status} ${refusal.status === 403 ? "Forbidden" : "Bad Request"}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      refusal.message,
    ].join("\r\n"),
  );
  socket.destroy();
}

function validateHandshake(req: IncomingMessage): UpgradeRefusal | undefined {
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    return { status: 400, message: "this endpoint only accepts a WebSocket upgrade" };
  }
  if (header(req, "sec-websocket-version") !== "13") {
    return { status: 400, message: "only WebSocket version 13 is supported" };
  }
  const key = header(req, "sec-websocket-key");
  if (key === undefined || Buffer.from(key, "base64").length !== 16) {
    return { status: 400, message: "missing or malformed Sec-WebSocket-Key" };
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export interface WebSocketHandlers {
  /** A complete text message. Throwing closes the socket with an error. */
  message?: (text: string) => void;
  closed?: (reason: string) => void;
}

/**
 * One upgraded socket: whole text messages in, whole text messages out.
 *
 * Keepalive is not decoration. A UI session holds the project's single write
 * slot (PLAN.md §12), so a browser that vanished without closing its TCP
 * connection would keep the slot forever and lock the human out of their own
 * project. The ping/pong deadline is what releases it.
 */
export class WebSocketConnection {
  private readonly decoder: FrameDecoder;
  private handlers: WebSocketHandlers = {};
  private open = true;
  private awaitingPong = false;
  private keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly socket: Duplex,
    maxMessageBytes: number,
  ) {
    this.decoder = new FrameDecoder(maxMessageBytes);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error: Error) => this.finish(`socket error: ${error.message}`));
    socket.on("close", () => this.finish("socket closed"));
  }

  on(handlers: WebSocketHandlers): void {
    this.handlers = handlers;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Start pinging. `intervalMs` is both the gap between pings and the deadline
   * for a reply, so a dead peer is reaped within two intervals.
   */
  startKeepalive(intervalMs: number): void {
    if (this.keepalive !== undefined) return;
    this.keepalive = setInterval(() => {
      if (!this.open) return;
      if (this.awaitingPong) {
        this.close(CLOSE_GOING_AWAY, "no pong within the keepalive window");
        return;
      }
      this.awaitingPong = true;
      this.send(OPCODE_PING, Buffer.alloc(0));
    }, intervalMs);
    this.keepalive.unref();
  }

  sendText(text: string): void {
    this.send(OPCODE_TEXT, Buffer.from(text, "utf8"));
  }

  /**
   * Feed bytes that arrived with the upgrade request itself. A fast client can
   * put its first frame in the same TCP segment as the handshake, and `http`
   * hands those bytes over as `head` rather than re-emitting them as `data`;
   * dropping them would lose the `hello` and time the socket out.
   */
  ingest(chunk: Buffer): void {
    this.receive(chunk);
  }

  close(code: number, reason: string): void {
    if (!this.open) return;
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason, "utf8"));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    this.send(OPCODE_CLOSE, payload);
    this.open = false;
    // Give the close frame a chance to leave before the socket goes away.
    this.socket.end();
    this.finish(`closed: ${reason}`);
  }

  private receive(chunk: Buffer): void {
    if (!this.open) return;
    const result = this.decoder.push(chunk);
    if (!result.ok) {
      this.close(result.failure.code, result.failure.reason);
      return;
    }
    for (const message of result.messages) {
      switch (message.kind) {
        case "text":
          try {
            this.handlers.message?.(message.text);
          } catch (error) {
            this.close(CLOSE_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
            return;
          }
          break;
        case "ping":
          this.send(OPCODE_PONG, message.payload);
          break;
        case "pong":
          this.awaitingPong = false;
          break;
        case "close":
          this.open = false;
          this.send(OPCODE_CLOSE, Buffer.alloc(0));
          this.socket.end();
          this.finish(`peer closed (${message.code ?? "no code"})`);
          return;
      }
      if (!this.open) return;
    }
  }

  private send(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  private finish(reason: string): void {
    if (this.keepalive !== undefined) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
    this.open = false;
    const closed = this.handlers.closed;
    this.handlers = {};
    closed?.(reason);
  }
}
