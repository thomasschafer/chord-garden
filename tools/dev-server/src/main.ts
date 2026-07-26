import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebBundles, REPO_ROOT } from "./bundle.js";
import { createAssetServer, summarise, type ProjectMount } from "./server.js";
import { ProjectSync } from "./sync.js";

const DEFAULT_PORT = 4173;
const DEFAULT_PROJECT = "fixtures/valid/first-track";
const HOST = "127.0.0.1";

interface Options {
  projects: ProjectMount[];
  port: number;
  build: boolean;
  verbose: boolean;
}

const USAGE = `usage: chord-garden-dev [--project <dir>]... [--port <n>] [--no-build] [--verbose]

Serves a project bundle and the live-engine harness page over loopback HTTP.
Defaults to ${DEFAULT_PROJECT} on port ${DEFAULT_PORT}.`;

export function parseArgs(argv: readonly string[]): Options {
  const projects: ProjectMount[] = [];
  let port = DEFAULT_PORT;
  let build = true;
  let verbose = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--project": {
        const value = argv[++index];
        if (value === undefined) throw new Error("--project needs a directory");
        projects.push(mount(value));
        break;
      }
      case "--port": {
        const value = argv[++index];
        if (value === undefined || !/^\d+$/.test(value)) throw new Error(`--port needs a number, got ${String(value)}`);
        port = Number(value);
        break;
      }
      case "--no-build":
        build = false;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }

  if (projects.length === 0) projects.push(mount(join(REPO_ROOT, DEFAULT_PROJECT)));
  return { projects, port, build, verbose };
}

/** A project directory becomes a mount named after its own directory. */
function mount(dir: string): ProjectMount {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`cannot serve "${dir}": it is not a directory`);
  }
  return { name: basename(root), root };
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const bundleRoot = join(REPO_ROOT, "tools/dev-server/build");

  if (options.build) {
    try {
      const outputs = await buildWebBundles(bundleRoot);
      for (const output of outputs) {
        process.stdout.write(`bundled ${output.name} (${(output.bytes / 1024).toFixed(1)} kB)\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nIf the engine's build output is missing, run \`npm run build\` first.`);
    }
  }

  // Loading each project up front turns "the fixture does not validate" into a
  // startup failure with diagnostics, rather than a puzzling browser console.
  for (const project of options.projects) {
    const summary = summarise(project);
    const errors = summary.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    process.stdout.write(
      `project ${summary.name}: ${summary.files.length} documents, ${errors.length} errors, ${summary.diagnostics.length - errors.length} warnings (${project.root})\n`,
    );
    for (const diagnostic of errors) {
      process.stdout.write(`  error ${diagnostic.file}: ${diagnostic.code} ${diagnostic.message}\n`);
    }
  }

  // A fresh unguessable token per run (PLAN.md §10). It never appears in a URL;
  // the served pages carry it to their own scripts, which send it as a header.
  const token = randomBytes(32).toString("hex");
  const appRoot = join(REPO_ROOT, "app/dist");

  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // One watcher per open project (PLAN.md §12). Sync logging is not tied to
  // `--verbose`: an external edit arriving, or a project on disk that stopped
  // validating, is the kind of thing you want in the terminal by default when
  // an agent is editing the files underneath you.
  const syncs = new Map(
    options.projects.map((project) => [project.name, new ProjectSync({ mount: project, token, log })]),
  );

  const server = createAssetServer({
    projects: options.projects,
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot,
    token,
    syncs,
    ...(existsSync(appRoot) ? { appRoot } : {}),
    ...(options.verbose ? { log } : {}),
  });
  server.on("close", () => {
    for (const sync of syncs.values()) sync.close();
  });

  await new Promise<void>((resolveListen) => {
    // Loopback only, per PLAN.md §10: this serves files off the developer's disk.
    server.listen(options.port, HOST, resolveListen);
  });
  const first = options.projects[0]!;
  if (existsSync(appRoot)) {
    process.stdout.write(`\nchord-garden app on http://localhost:${options.port}/app/?project=${first.name}\n`);
  } else {
    process.stdout.write(
      `\nno app build at ${appRoot}; run \`npm run build -w @chord-garden/app\` to serve the UI at /app/\n`,
    );
  }
  process.stdout.write(`engine harness on http://localhost:${options.port}/?project=${first.name}\n`);
  process.stdout.write("click \"start audio\" in either page; the console logs everything under [chord-garden]\n");
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
