import type { Diagnostic } from "./diagnostics.js";

export interface StepsParseResult {
  /** Zero-based indices of `x` steps. Present only when there are no errors. */
  hits?: number[];
  diagnostics: Diagnostic[];
}

export interface StepsContext {
  file: string;
  pointer: string;
  stepsPerBar: number;
  bars: number;
}

/**
 * Parses a placement-only steps string (`x`/`.`, spaces cosmetic, `|` on bar
 * boundaries). Grammar per format-spec §pattern-strings; `X` and `-` are
 * reserved and rejected with targeted diagnostics.
 */
export function parseSteps(steps: string, ctx: StepsContext): StepsParseResult {
  const diagnostics: Diagnostic[] = [];
  const hits: number[] = [];
  let count = 0;

  for (let i = 0; i < steps.length; i++) {
    const c = steps[i]!;
    if (c === " ") continue;
    if (c === "|") {
      if (count === 0 || count % ctx.stepsPerBar !== 0) {
        diagnostics.push({
          severity: "error",
          code: "pattern.bar-separator-misplaced",
          file: ctx.file,
          pointer: ctx.pointer,
          span: { start: i, end: i + 1 },
          message: `\`|\` at column ${i + 1} does not fall on a bar boundary (${ctx.stepsPerBar} steps per bar)`,
        });
      }
      continue;
    }
    if (c === "x") {
      hits.push(count);
      count++;
      continue;
    }
    if (c === ".") {
      count++;
      continue;
    }
    if (c === "X") {
      diagnostics.push({
        severity: "error",
        code: "pattern.accent-unsupported",
        file: ctx.file,
        pointer: ctx.pointer,
        span: { start: i, end: i + 1 },
        message: `accented trigger \`X\` at column ${i + 1} is not supported yet`,
        suggestion: "use lowercase `x` and set `velocity` in `stepEvents`",
      });
      count++;
      continue;
    }
    if (c === "-") {
      diagnostics.push({
        severity: "error",
        code: "pattern.tie-unsupported",
        file: ctx.file,
        pointer: ctx.pointer,
        span: { start: i, end: i + 1 },
        message: `tie marker \`-\` at column ${i + 1} is reserved for future melodic grids and not valid in drum lanes`,
      });
      count++;
      continue;
    }
    diagnostics.push({
      severity: "error",
      code: "pattern.invalid-char",
      file: ctx.file,
      pointer: ctx.pointer,
      span: { start: i, end: i + 1 },
      message: `invalid character \`${c}\` at column ${i + 1}; a steps string may contain only \`x\`, \`.\`, spaces, and \`|\``,
    });
    count++;
  }

  const expected = ctx.stepsPerBar * ctx.bars;
  if (count !== expected) {
    const delta = expected - count;
    diagnostics.push({
      severity: "error",
      code: "pattern.step-count-mismatch",
      file: ctx.file,
      pointer: ctx.pointer,
      span: { start: 0, end: steps.length },
      message: `lane has ${count} steps but stepsPerBar*bars = ${expected}`,
      suggestion:
        delta > 0 ? `add ${delta} \`.\` to reach ${expected} steps` : `remove ${-delta} steps to reach ${expected}`,
    });
  }

  if (diagnostics.length > 0) return { diagnostics };
  return { hits, diagnostics };
}

/**
 * Canonical steps string: bars joined with ` | `, steps grouped in blocks of
 * four when possible, otherwise the largest divisor of stepsPerBar that is
 * <= 4 and > 1, otherwise ungrouped.
 */
export function formatSteps(hits: readonly number[], stepsPerBar: number, bars: number): string {
  const hitSet = new Set(hits);
  const groupSize = canonicalGroupSize(stepsPerBar);
  const barStrings: string[] = [];
  for (let bar = 0; bar < bars; bar++) {
    let barString = "";
    for (let s = 0; s < stepsPerBar; s++) {
      if (s > 0 && groupSize > 0 && s % groupSize === 0) barString += " ";
      barString += hitSet.has(bar * stepsPerBar + s) ? "x" : ".";
    }
    barStrings.push(barString);
  }
  return barStrings.join(" | ");
}

function canonicalGroupSize(stepsPerBar: number): number {
  for (const size of [4, 3, 2]) {
    if (stepsPerBar % size === 0) return size;
  }
  return 0;
}
