import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssetServer } from "../src/server.js";
import { rawRequest } from "./helpers.js";

/**
 * What happens when a file this server is asked for cannot simply be read.
 *
 * This process owns the user's project directory and holds their unsaved edits,
 * and the triggers here are accidents rather than attacks — a permission quirk, a
 * sample being rewritten underneath a request. Serving a file used to `statSync`
 * it and then let a `ReadStream` do its own `open`, with no `error` listener on
 * the stream: a file that passed the `stat` and failed the `open` raised an
 * unhandled `'error'` event, which Node turns into an uncaught exception. One
 * `chmod 000` on a sample and the whole dev server was gone.
 *
 * The bundle route is used because it hands `sendFile` a path directly, with none
 * of the resolution `/files/` does first, so what is under test is `sendFile`
 * itself rather than the path allowlist.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

let server: Server;
let port: number;
let bundleRoot: string;

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), "chord-garden-bundles-"));
  writeFileSync(join(bundleRoot, "harness.js"), "export const ok = 1;\n");
  writeFileSync(join(bundleRoot, "harness.js.map"), "{}\n");
  chmodSync(join(bundleRoot, "harness.js.map"), 0o000);
  // A FIFO nothing will ever write to: an `open` without `O_NONBLOCK` waits here
  // forever, and these reads are on the request path.
  execFileSync("mkfifo", [join(bundleRoot, "worklet.js")]);

  server = createAssetServer({
    projects: [{ name: "first-track", root: `${REPO_ROOT}fixtures/valid/first-track` }],
    webRoot: `${REPO_ROOT}tools/dev-server/web`,
    bundleRoot,
    token: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  chmodSync(join(bundleRoot, "harness.js.map"), 0o600);
  rmSync(bundleRoot, { recursive: true, force: true });
});

function get(path: string) {
  return rawRequest(port, path, { token: TOKEN });
}

describe("serving a file that cannot be read", () => {
  it("still serves a readable bundle", async () => {
    const response = await get("/harness.js");
    expect(response.status).toBe(200);
    expect(response.body).toContain("export const ok");
  });

  it("answers 500 for an unreadable file instead of taking the process down", async () => {
    // The premise, asserted rather than assumed: as root, mode 000 is still
    // readable and the failure this test exists to reproduce cannot be created.
    // Reported as a failure rather than skipped, because a suite that quietly
    // stops checking this on some machines is what let the bug through.
    let readable = true;
    try {
      accessSync(join(bundleRoot, "harness.js.map"), constants.R_OK);
    } catch {
      readable = false;
    }
    expect(readable, "this test needs a non-root user: a mode-000 file was still readable").toBe(false);

    const response = await get("/harness.js.map");
    // 500, not 403: the client is entitled to this file and the server could not
    // read it. 403 is reserved for the refusals this server decides on — a path
    // outside the root, an unservable extension, a bad token — and conflating the
    // two sends the reader auditing an access rule when the fix is one `chmod`.
    expect(response.status).toBe(500);
    expect(response.body).toContain("EACCES");
  });

  it("answers 404 for a FIFO rather than waiting for a writer", async () => {
    const response = await get("/worklet.js");
    expect(response.status).toBe(404);
    expect(response.body).toContain("not a regular file");
  });

  it("answers 404 for a bundle that is not there", async () => {
    const response = await get("/worklet.js.map");
    expect(response.status).toBe(404);
    expect(response.body).toContain("not built");
  });

  it("is still serving everything else afterwards", async () => {
    // The point of all of the above: the process is alive and its event loop is
    // not wedged once the bad requests have been answered.
    const response = await get("/api/projects");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ projects: [{ name: "first-track" }] });
  });
});
