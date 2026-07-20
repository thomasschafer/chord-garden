#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalFiles,
  describeProject,
  loadProject,
  type Diagnostic,
  type DescribeReport,
  type LoadResult,
} from "@chord-garden/format";

const USAGE = `usage:
  musictool validate <project> [--json]   check schema, pattern grammar, and semantic rules
  musictool fmt <project> [--check]       rewrite files to canonical bytes (--check: report only)
  musictool describe <project> [--json]   summarise the project
  musictool render ...                    not yet implemented (arrives in Phase 1)
`;

main();

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const root = positional[0];

  switch (command) {
    case "validate":
      exit(runValidate(requireRoot(root), flags.has("--json")));
      break;
    case "fmt":
      exit(runFmt(requireRoot(root), flags.has("--check")));
      break;
    case "describe":
      exit(runDescribe(requireRoot(root), flags.has("--json")));
      break;
    case "render":
      process.stderr.write("musictool render is not implemented yet; it arrives in Phase 1 with the offline renderer.\n");
      exit(2);
      break;
    default:
      process.stderr.write(USAGE);
      exit(2);
  }
}

function requireRoot(root: string | undefined): string {
  if (root === undefined) {
    process.stderr.write(USAGE);
    exit(2);
  }
  return resolve(root);
}

function runValidate(root: string, json: boolean): number {
  const result = loadProject(root);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: result.ok, diagnostics: result.diagnostics }, null, 2) + "\n");
  } else {
    printDiagnostics(result.diagnostics);
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
    process.stdout.write(
      result.ok
        ? `valid (${warnings} warning${warnings === 1 ? "" : "s"})\n`
        : `invalid: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

function runFmt(root: string, checkOnly: boolean): number {
  const result = loadProject(root);
  if (!result.ok || result.project === undefined) {
    printDiagnostics(result.diagnostics);
    process.stderr.write("fmt refused: fix validation errors first\n");
    return 1;
  }
  const changed: string[] = [];
  for (const [path, canonical] of canonicalFiles(result.project)) {
    const absolute = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(absolute, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== canonical) {
      changed.push(path);
      if (!checkOnly) writeFileSync(absolute, canonical);
    }
  }
  if (changed.length === 0) {
    process.stdout.write("already canonical\n");
    return 0;
  }
  for (const path of changed) {
    process.stdout.write(`${checkOnly ? "would rewrite" : "rewrote"} ${path}\n`);
  }
  return checkOnly ? 1 : 0;
}

function runDescribe(root: string, json: boolean): number {
  const result = loadProject(root);
  if (result.project === undefined) {
    printDiagnostics(result.diagnostics);
    return 1;
  }
  const report = describeProject(result.project);
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHumanDescribe(report, result);
  }
  return result.ok ? 0 : 1;
}

function printHumanDescribe(report: DescribeReport, result: LoadResult): void {
  const [num, den] = report.timeSignature;
  const key = report.key ? `${report.key.root} ${report.key.scale}` : "none";
  process.stdout.write(`${report.name} — ${formatBpm(report.bpm)} bpm, ${num}/${den}, key: ${key}, ${report.bars} bars\n`);
  for (const track of report.tracks) {
    const automation = track.automatedParams.length > 0 ? `, automates ${track.automatedParams.join(", ")}` : "";
    process.stdout.write(
      `  ${track.id} (${track.type} → ${track.instrument}): patterns [${track.patterns.join(", ")}], ${track.clipCount} clip${track.clipCount === 1 ? "" : "s"}${automation}\n`,
    );
  }
  for (const pattern of report.patterns) {
    if (pattern.kind === "grid") {
      const lanes = (pattern.lanes ?? []).map((l) => `${l.lane}:${l.hits}`).join(" ");
      process.stdout.write(`  pattern ${pattern.id} (grid, ${pattern.bars} bar${pattern.bars === 1 ? "" : "s"}): hits ${lanes}\n`);
    } else {
      const range = pattern.pitchRange ? `, ${pattern.pitchRange[0]}–${pattern.pitchRange[1]}` : "";
      process.stdout.write(`  pattern ${pattern.id} (notes, ${pattern.bars} bar${pattern.bars === 1 ? "" : "s"}): ${pattern.noteCount} notes${range}\n`);
    }
  }
  if (result.diagnostics.length > 0) {
    process.stdout.write("diagnostics:\n");
    printDiagnostics(result.diagnostics);
  }
}

function formatBpm(bpm100: number): string {
  return bpm100 % 100 === 0 ? String(bpm100 / 100) : (bpm100 / 100).toFixed(2);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) {
    const loc = d.loc ? `:${d.loc.line}:${d.loc.column}` : "";
    const pointer = d.pointer !== undefined && d.pointer !== "" ? ` ${d.pointer}` : "";
    const suggestion = d.suggestion ? ` (${d.suggestion})` : "";
    process.stderr.write(`${d.severity} ${d.code} ${d.file}${loc}${pointer} — ${d.message}${suggestion}\n`);
  }
}

function exit(code: number): never {
  process.exit(code);
}
