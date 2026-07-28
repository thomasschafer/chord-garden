import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { Duplex } from "node:stream";
import { SESSION_HEADER, TOKEN_HEADER } from "../src/api.js";

export interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface RawOptions {
  method?: string | undefined;
  /** Overrides the `Host` header; omit for the loopback default. */
  host?: string | undefined;
  /** Sends an `Origin` header. Omit to send none, as a same-origin GET does. */
  origin?: string | undefined;
  /** Sends the session token. Omit to send none. */
  token?: string | undefined;
  /** Sends the read-write session id from the socket's welcome. Omit to send none. */
  session?: string | undefined;
  body?: string | undefined;
  contentType?: string | undefined;
}

/**
 * A raw HTTP request against the dev server.
 *
 * `fetch` refuses to let a caller set `Host` or a forged `Origin`, and those are
 * two of the three things worth testing about this server, so the tests speak
 * `node:http` directly.
 */
export function rawRequest(port: number, path: string, options: RawOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers["host"] = options.host;
    if (options.origin !== undefined) headers["origin"] = options.origin;
    if (options.token !== undefined) headers[TOKEN_HEADER] = options.token;
    if (options.session !== undefined) headers[SESSION_HEADER] = options.session;
    if (options.body !== undefined) {
      headers["content-type"] = options.contentType ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }

    const call = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? "", body }),
      );
    });
    call.on("error", reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

/**
 * Build a client frame the way a browser would: masked, with the length encoded
 * in whichever of the three forms the payload calls for.
 *
 * Shared rather than duplicated: the decoder tests and the keepalive tests both
 * need to speak client-side RFC 6455, and two copies of a frame builder is two
 * chances to encode a mask differently and test the wrong thing.
 */
export function clientFrame(
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

/** A masked client text frame, which is all this protocol's clients ever send. */
export function clientText(value: string, options?: Parameters<typeof clientFrame>[2]): Buffer {
  return clientFrame(0x1, Buffer.from(value, "utf8"), options);
}

/**
 * A stand-in for the upgraded TCP socket, so a `WebSocketConnection` can be driven
 * without a server, a port, or a real browser.
 *
 * The two directions are kept apart deliberately: `receive` pushes bytes as if the
 * peer sent them, and everything the connection writes lands in `sent`. A
 * `PassThrough` would loop the server's own frames back into its decoder.
 */
export class FakeSocket extends Duplex {
  /** Every chunk the connection has written, in order. */
  readonly sent: Buffer[] = [];

  override _read(): void {
    // Bytes arrive by `receive`; there is nothing to pull.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.sent.push(Buffer.from(chunk));
    done();
  }

  /** Deliver bytes as if the peer had sent them. */
  receive(bytes: Buffer): void {
    this.push(bytes);
  }

  /** The opcodes the connection has sent, for asserting on pings and closes. */
  sentOpcodes(): number[] {
    return this.sent.filter((chunk) => chunk.length > 0).map((chunk) => chunk[0]! & 0x0f);
  }
}
