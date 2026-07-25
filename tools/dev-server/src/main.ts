import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebBundles, REPO_ROOT } from "./bundle.js";
import { createAssetServer, summarise, type ProjectMount } from "./server.js";

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

  const server = createAssetServer({
    projects: options.projects,
    webRoot: join(REPO_ROOT, "tools/dev-server/web"),
    bundleRoot,
    ...(options.verbose ? { log: (line: string) => process.stdout.write(`${line}\n`) } : {}),
  });

  await new Promise<void>((resolveListen) => {
    // Loopback only, per PLAN.md §10: this serves files off the developer's disk.
    server.listen(options.port, HOST, resolveListen);
  });
  const first = options.projects[0]!;
  process.stdout.write(`\nchord-garden dev server on http://localhost:${options.port}/?project=${first.name}\n`);
  process.stdout.write("click \"start audio\" in the page; the console logs everything under [chord-garden]\n");
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
