import { request } from "node:http";
import { TOKEN_HEADER } from "../src/api.js";

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
