import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every workspace package that other packages import by name.
 *
 * Read by two things that must agree: the vitest source aliases, and the
 * published-entry-point test that checks the same `exports` maps still resolve
 * once built.
 */
export const ALIASED_PACKAGES = ["packages/format", "packages/engine", "packages/cli", "tools/dev-server"] as const;

export interface ExportTarget {
  /** Export subpath key, `"."` or `"./…"`. */
  subpath: string;
  /** The bare specifier this subpath is imported as. */
  specifier: string;
  /** `exports[subpath].default`, relative to the package directory. */
  runtime: string;
  /** `exports[subpath].types`, relative to the package directory. */
  types: string;
}

export interface PackageExports {
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  targets: readonly ExportTarget[];
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object, found ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string") throw new Error(`${what} has no string "${key}"`);
  return value;
}

/**
 * The `exports` map of one workspace package, read from disk.
 *
 * Deliberately strict: an entry this cannot understand is thrown on rather than
 * skipped, because a silently skipped entry is an entry with no alias and no
 * smoke coverage, which is the exact hole both callers exist to close.
 */
export function readPackageExports(relativeDir: string): PackageExports {
  const dir = resolve(REPO_ROOT, relativeDir);
  const manifestPath = resolve(dir, "package.json");
  const manifest = asObject(JSON.parse(readFileSync(manifestPath, "utf8")), manifestPath);
  const name = requireString(manifest, "name", manifestPath);

  const exported = asObject(manifest["exports"], `${manifestPath} "exports"`);
  const targets = Object.entries(exported).map(([subpath, condition]): ExportTarget => {
    const where = `${manifestPath} exports["${subpath}"]`;
    const conditions = asObject(condition, where);
    return {
      subpath,
      specifier: specifierFor(name, subpath),
      runtime: requireString(conditions, "default", where),
      types: requireString(conditions, "types", where),
    };
  });
  if (targets.length === 0) throw new Error(`${manifestPath} has an empty "exports" map`);
  return { name, dir, targets };
}

/** The bare specifier an `exports` subpath key is imported as. */
export function specifierFor(name: string, subpath: string): string {
  if (subpath === ".") return name;
  if (!subpath.startsWith("./")) throw new Error(`${name} exports key "${subpath}" is neither "." nor "./…"`);
  return `${name}/${subpath.slice(2)}`;
}

export function allPackageExports(): PackageExports[] {
  return ALIASED_PACKAGES.map(readPackageExports);
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

/**
 * One vitest alias per published subpath, derived from the `exports` map rather
 * than listed by hand, so a new export cannot be added without being covered.
 *
 * The `find` patterns are anchored: a plain string alias matches by prefix, which
 * would rewrite `@chord-garden/format/pure` using the `.` entry and produce
 * `…/src/index.ts/pure`.
 */
export function sourceAliases({ name, dir, targets }: PackageExports): SourceAlias[] {
  return targets.map(({ subpath, specifier, runtime }) => {
    const emitted = /^\.\/dist\/(.+)\.js$/.exec(runtime);
    if (emitted === null) {
      throw new Error(`${name} exports "${subpath}" as "${runtime}", which is not a ./dist/*.js path; no source alias can be derived`);
    }
    const source = resolve(dir, "src", `${emitted[1]!}.ts`);
    if (!existsSync(source)) {
      throw new Error(`${name} exports "${subpath}" as "${runtime}", but its source ${source} does not exist`);
    }
    return { find: new RegExp(`^${escapeForRegExp(specifier)}$`), replacement: source };
  });
}
