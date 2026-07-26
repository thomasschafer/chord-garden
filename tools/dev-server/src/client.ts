import {
  assembleProject,
  parseStrictJson,
  type AssembledFile,
  type Project,
} from "@chord-garden/format/pure";
import {
  TOKEN_GLOBAL,
  TOKEN_HEADER,
  WRITE_CONFLICT_STATUS,
  type ProjectList,
  type ProjectSummary,
  type WriteRequest,
  type WriteRequestFile,
  type WriteResponse,
} from "./api.js";

/**
 * The browser's half of the sidecar protocol.
 *
 * Node-free on purpose, and the only place in the browser that knows the URL
 * shape or the auth header: the app and the Phase 2 harness both go through it,
 * so there is one description of how to talk to the server rather than two that
 * drift. When Phase 4 adds the WebSocket, it is added here.
 */

/**
 * A write was refused because at least one file had changed on disk since this
 * editor last read it. Its own class because the only correct response is to
 * stop and tell the human — retrying would overwrite the other editor, and
 * reconciling is Phase 4 work that would be worse guessed at than deferred.
 */
export class WriteConflict extends Error {
  readonly paths: readonly string[];

  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = "WriteConflict";
    this.paths = paths;
  }
}

/** A loaded project plus the exact bytes each document had on the server. */
export interface LoadedProject {
  project: Project;
  summary: ProjectSummary;
  /** Project-relative path to the raw text served for it. */
  texts: Map<string, string>;
}

export class ProjectClient {
  private readonly token: string;
  private readonly base: string;

  /**
   * @param token session token, normally read from the injected global.
   * @param base  origin to talk to; defaults to the page's own.
   */
  constructor(token: string, base = "") {
    if (token.length === 0) {
      throw new Error(
        `no session token: the page must be served by the chord-garden dev server, which defines window.${TOKEN_GLOBAL}`,
      );
    }
    this.token = token;
    this.base = base;
  }

  /**
   * Read the token the server injected into this page, or fail loudly.
   *
   * `scope` is passed in rather than defaulted to `window` so this file stays
   * free of DOM globals and can be compiled by the Node-typed build alongside
   * the server it talks to.
   */
  static fromPage(scope: Record<string, unknown>): ProjectClient {
    const token = scope[TOKEN_GLOBAL];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `window.${TOKEN_GLOBAL} is missing; open this page through the chord-garden dev server rather than from a file or another origin`,
      );
    }
    return new ProjectClient(token);
  }

  /**
   * The session token this client authenticates with.
   *
   * Exposed because the sync socket authenticates with the same token in its
   * first message (PLAN.md §10) and there should be one place that knows how a
   * page comes by it — not two readers of the same injected global.
   */
  get sessionToken(): string {
    return this.token;
  }

  async listProjects(): Promise<ProjectList> {
    return this.json<ProjectList>("/api/projects");
  }

  async summary(name: string): Promise<ProjectSummary> {
    return this.json<ProjectSummary>(this.projectUrl(name));
  }

  /** Fetch a project-relative file as raw bytes (samples, mostly). */
  async asset(name: string, path: string): Promise<Uint8Array> {
    const url = `${this.projectUrl(name)}/files/${path}`;
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${await response.text()}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Fetch every document of a project and index it into the canonical model.
   *
   * The server has already schema- and semantic-validated the bundle and says so
   * in the summary; the browser still re-parses each document with the format
   * package's own strict parser rather than `JSON.parse`, so a file the loader
   * would reject (a comment, a duplicate key) is rejected here too instead of
   * quietly becoming a different document than the one on disk.
   */
  async loadProject(name: string): Promise<LoadedProject> {
    const summary = await this.summary(name);
    const errors = summary.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (!summary.ok) {
      throw new Error(
        `project "${name}" does not validate (${errors.length} errors): ${errors
          .map((diagnostic) => `${diagnostic.file}: ${diagnostic.message}`)
          .join("; ")}`,
      );
    }

    const documents: AssembledFile[] = [];
    const texts = new Map<string, string>();
    for (const file of summary.files) {
      const url = `${this.projectUrl(name)}/files/${file.path}`;
      const response = await this.fetch(url);
      if (!response.ok) throw new Error(`GET ${file.path} → ${response.status}`);
      const text = await response.text();
      const parsed = parseStrictJson(text, file.path);
      if (parsed.value === undefined) {
        throw new Error(
          `${file.path} did not parse: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
        );
      }
      texts.set(file.path, text);
      documents.push({ kind: file.kind, value: parsed.value });
    }

    return { project: assembleProject(this.projectUrl(name), documents), summary, texts };
  }

  /**
   * Persist a batch of canonical documents. Rejects on any server refusal, with
   * a `WriteConflict` when the disk moved under the caller so that a UI can tell
   * "someone else edited this" apart from "the write failed".
   */
  async write(name: string, files: readonly WriteRequestFile[]): Promise<WriteResponse> {
    const url = `${this.projectUrl(name)}/write`;
    const body: WriteRequest = { files: [...files] };
    const response = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === WRITE_CONFLICT_STATUS) {
      throw new WriteConflict(await response.text(), files.map((file) => file.path));
    }
    if (!response.ok) {
      throw new Error(`write to "${name}" failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as WriteResponse;
  }

  private projectUrl(name: string): string {
    return `${this.base}/api/projects/${encodeURIComponent(name)}`;
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetch(`${this.base}${url}`);
    if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), [TOKEN_HEADER]: this.token },
    });
  }
}
