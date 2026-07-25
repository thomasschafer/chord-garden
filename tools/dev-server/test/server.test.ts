import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectSummary } from "../src/api.js";
import { createAssetServer } from "../src/server.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PROJECT_ROOT = `${REPO_ROOT}fixtures/valid/first-track`;

let server: Server;
let port: number;

beforeAll(async () => {
  server = createAssetServer({
    projects: [{ name: "first-track", root: PROJECT_ROOT }],
    webRoot: `${REPO_ROOT}tools/dev-server/web`,
    bundleRoot: `${REPO_ROOT}tools/dev-server/build`,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

interface Response {
  status: number;
  contentType: string;
  body: string;
}

/**
 * A raw request, because `fetch` will not let a test send the wrong `Host`, and
 * the Host check is one of the things worth testing.
 */
function get(path: string, options: { method?: string; host?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        ...(options.host === undefined ? {} : { headers: { host: options.host } }),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"] ?? "", body }),
        );
      },
    );
    call.on("error", reject);
    call.end();
  });
}

describe("dev asset server", () => {
  it("serves the harness page at the root", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("chord-garden live engine harness");
  });

  it("lists the mounted projects", async () => {
    const response = await get("/api/projects");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ projects: [{ name: "first-track", root: PROJECT_ROOT }] });
  });

  it("summarises a project with every document's resolved kind", async () => {
    const response = await get("/api/projects/first-track");
    expect(response.status).toBe(200);
    const summary = JSON.parse(response.body) as ProjectSummary;
    expect(summary.ok).toBe(true);
    expect(summary.diagnostics).toEqual([]);
    const kinds = new Map(summary.files.map((file) => [file.path, file.kind]));
    expect(kinds.get("project.json")).toBe("project");
    expect(kinds.get("arrangement.json")).toBe("arrangement");
    expect(kinds.get("instruments/drumkit-main.json")).toBe("instrument.drumkit");
    expect(kinds.get("patterns/drums-verse.json")).toBe("pattern.grid");
    // The paths in the summary are exactly what the browser will ask for next.
    expect(summary.files.map((file) => file.path)).toEqual([...kinds.keys()].sort());
  });

  it("serves each summarised document and every referenced sample", async () => {
    const summary = JSON.parse((await get("/api/projects/first-track")).body) as ProjectSummary;
    for (const file of summary.files) {
      const response = await get(`/api/projects/first-track/files/${file.path}`);
      expect(response.status, file.path).toBe(200);
      expect(response.contentType, file.path).toContain("application/json");
    }
    const sample = await get("/api/projects/first-track/files/samples/kick.wav");
    expect(sample.status).toBe(200);
    expect(sample.contentType).toBe("audio/wav");
    expect(sample.body.startsWith("RIFF")).toBe(true);
  });

  it("refuses to serve anything outside the project root", async () => {
    for (const attempt of [
      "/api/projects/first-track/files/..%2F..%2Fpackage.json",
      "/api/projects/first-track/files/%2e%2e%2fsecrets.json",
      "/api/projects/first-track/files/%2Fetc%2Fpasswd",
    ]) {
      const response = await get(attempt);
      expect(response.status, attempt).toBe(403);
      expect(response.body, attempt).toMatch(/project-relative|outside the project root/);
    }
  });

  it("404s an unknown project and an unknown route", async () => {
    expect((await get("/api/projects/nope")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
  });

  it("is read-only: anything but GET and HEAD is refused", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await get("/api/projects/first-track", { method });
      expect(response.status, method).toBe(405);
    }
    const head = await get("/api/projects/first-track", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("answers only to loopback host names", async () => {
    expect((await get("/", { host: "attacker.example.com" })).status).toBe(403);
    expect((await get("/", { host: `localhost:${port}` })).status).toBe(200);
    expect((await get("/", { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await get("/", { host: "[::1]" })).status).toBe(200);
  });
});
