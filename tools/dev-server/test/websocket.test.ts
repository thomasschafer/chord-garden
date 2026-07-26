import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_LARGE,
  CLOSE_UNSUPPORTED_DATA,
  FrameDecoder,
  acceptKey,
  encodeFrame,
} from "../src/websocket.js";

const MAX = 1024;

/**
 * Build a client frame the way a browser would: masked, with the length encoded
 * in whichever of the three forms the payload calls for.
 */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; masked?: boolean; rsv?: number; declaredLength?: number } = {},
): Buffer {
  const fin = options.fin ?? true;
  const masked = options.masked ?? true;
  const length = options.declaredLength ?? payload.length;
  const header: number[] = [((fin ? 0x80 : 0) | (options.rsv ?? 0) | opcode) & 0xff];
  const maskBit = masked ? 0x80 : 0;
  if (length < 126) {
    header.push(maskBit | length);
  } else if (length < 0x10000) {
    header.push(maskBit | 126, (length >> 8) & 0xff, length & 0xff);
  } else {
    header.push(maskBit | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), payload]);
  const mask = randomBytes(4);
  const masking = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index++) masking[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from(header), mask, masking]);
}

function text(value: string, options?: Parameters<typeof clientFrame>[2]): Buffer {
  return clientFrame(0x1, Buffer.from(value, "utf8"), options);
}

/** Decode a whole byte stream and return the messages, failing loudly if it errors. */
function decodeAll(decoder: FrameDecoder, bytes: Buffer): string[] {
  const result = decoder.push(bytes);
  if (!result.ok) throw new Error(`decode failed: ${result.failure.code} ${result.failure.reason}`);
  return result.messages.map((message) => {
    if (message.kind !== "text") throw new Error(`expected a text message, got ${message.kind}`);
    return message.text;
  });
}

describe("websocket handshake", () => {
  it("computes the RFC 6455 example accept value", () => {
    // The example from RFC 6455 §1.3, which pins the SHA-1 + GUID + base64 step.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("frame decoding", () => {
  it("reads a masked text frame", () => {
    expect(decodeAll(new FrameDecoder(MAX), text('{"type":"hello"}'))).toEqual(['{"type":"hello"}']);
  });

  it("reads several frames from one chunk", () => {
    const stream = Buffer.concat([text("one"), text("two"), text("three")]);
    expect(decodeAll(new FrameDecoder(MAX), stream)).toEqual(["one", "two", "three"]);
  });

  it("reassembles a message split across chunks, one byte at a time", () => {
    // The bug this exists to prevent: a frame header or payload arriving across
    // TCP segment boundaries. Every prefix must decode to nothing, and the last
    // byte to the whole message.
    const frame = text("a message long enough to span several segments");
    const decoder = new FrameDecoder(MAX);
    const seen: string[] = [];
    for (const byte of frame) {
      const result = decoder.push(Buffer.from([byte]));
      if (!result.ok) throw new Error(`byte-at-a-time decode failed: ${result.failure.reason}`);
      for (const message of result.messages) if (message.kind === "text") seen.push(message.text);
    }
    expect(seen).toEqual(["a message long enough to span several segments"]);
  });

  it("reads a two-byte and an eight-byte length header", () => {
    const medium = "m".repeat(200);
    const decoder = new FrameDecoder(1024 * 1024);
    expect(decodeAll(decoder, text(medium))).toEqual([medium]);
    const large = "l".repeat(70_000);
    expect(decodeAll(decoder, text(large))).toEqual([large]);
  });

  it("joins continuation frames into one message", () => {
    const stream = Buffer.concat([
      text("part one ", { fin: false }),
      clientFrame(0x0, Buffer.from("part two", "utf8")),
    ]);
    expect(decodeAll(new FrameDecoder(MAX), stream)).toEqual(["part one part two"]);
  });

  it("answers a ping and a close without treating them as messages", () => {
    const result = new FrameDecoder(MAX).push(
      Buffer.concat([clientFrame(0x9, Buffer.from("hi")), clientFrame(0x8, Buffer.from([0x03, 0xe8]))]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map((message) => message.kind)).toEqual(["ping", "close"]);
    expect(result.messages[1]).toMatchObject({ kind: "close", code: 1000 });
  });
});

describe("frame decoding refusals", () => {
  /** Every one of these must close the connection with a specific code. */
  const cases: [string, Buffer, number][] = [
    ["an unmasked client frame", text("nope", { masked: false }), CLOSE_PROTOCOL_ERROR],
    ["a reserved bit", text("nope", { rsv: 0x40 }), CLOSE_PROTOCOL_ERROR],
    ["a binary frame", clientFrame(0x2, Buffer.from([1, 2, 3])), CLOSE_UNSUPPORTED_DATA],
    ["an unknown opcode", clientFrame(0x5, Buffer.from("x")), CLOSE_PROTOCOL_ERROR],
    ["a fragmented control frame", clientFrame(0x9, Buffer.from("x"), { fin: false }), CLOSE_PROTOCOL_ERROR],
    ["an oversized control frame", clientFrame(0x9, Buffer.alloc(126)), CLOSE_PROTOCOL_ERROR],
    ["a continuation with nothing in progress", clientFrame(0x0, Buffer.from("x")), CLOSE_PROTOCOL_ERROR],
    ["a message over the limit", text("x".repeat(MAX + 1)), CLOSE_TOO_LARGE],
    ["a lie about the length", text("x", { declaredLength: MAX + 5 }), CLOSE_TOO_LARGE],
  ];

  for (const [name, bytes, code] of cases) {
    it(`refuses ${name}`, () => {
      const result = new FrameDecoder(MAX).push(bytes);
      expect(result.ok, name).toBe(false);
      if (result.ok) return;
      expect(result.failure.code, name).toBe(code);
    });
  }

  it("refuses a new message that interrupts a fragmented one", () => {
    const decoder = new FrameDecoder(MAX);
    expect(decoder.push(text("first half", { fin: false })).ok).toBe(true);
    const result = decoder.push(text("interrupting"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("refuses fragments that only exceed the limit together", () => {
    const decoder = new FrameDecoder(MAX);
    expect(decoder.push(text("x".repeat(600), { fin: false })).ok).toBe(true);
    const result = decoder.push(clientFrame(0x0, Buffer.from("y".repeat(600), "utf8")));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(CLOSE_TOO_LARGE);
  });

  it("stays failed once it has failed", () => {
    const decoder = new FrameDecoder(MAX);
    expect(decoder.push(text("nope", { masked: false })).ok).toBe(false);
    expect(decoder.push(text("a perfectly good frame")).ok).toBe(false);
  });

  it("refuses an announced-huge frame from its header alone, before buffering a payload", () => {
    // The trickle attack — declare a gigantic length, then send the body slowly —
    // has to be refused on the header, because anything that waits for the
    // payload has already agreed to buffer it. Ten bytes of header is all the
    // decoder is allowed to accept here.
    const header = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0x40, 0, 0, 0]);
    const result = new FrameDecoder(MAX).push(header);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(CLOSE_TOO_LARGE);
  });

  it("refuses a 64-bit length with anything in its high word", () => {
    const header = Buffer.from([0x81, 0xff, 0x00, 0x00, 0x00, 0x01, 0, 0, 0, 0]);
    const result = new FrameDecoder(MAX).push(header);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(CLOSE_TOO_LARGE);
  });
});

describe("frame encoding", () => {
  it("round-trips through the decoder once masked", () => {
    // Server frames are unmasked, so they are re-masked here to be read back;
    // what this pins is the header layout at each of the three length forms.
    for (const length of [0, 5, 125, 126, 200, 65_535, 65_536, 70_000]) {
      const payload = "q".repeat(length);
      const server = encodeFrame(0x1, Buffer.from(payload, "utf8"));
      const body = server.subarray(server.length - Buffer.byteLength(payload, "utf8"));
      expect(decodeAll(new FrameDecoder(1024 * 1024), clientFrame(0x1, body)), `length ${length}`).toEqual([payload]);
      expect((server[0]! & 0x80) !== 0, `fin at length ${length}`).toBe(true);
      expect((server[1]! & 0x80) === 0, `unmasked at length ${length}`).toBe(true);
    }
  });
});
