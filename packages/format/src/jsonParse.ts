import { type Diagnostic, type Loc, joinPointer } from "./diagnostics.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ParseResult {
  /** Present only when parsing succeeded with no diagnostics. */
  value?: JsonValue;
  /**
   * JSON Pointer → location of the value it points at. Always the value, never
   * the member's key: a semantic diagnostic placed through this map points at
   * the thing that is wrong rather than at the name in front of it.
   */
  locs: Map<string, Loc>;
  diagnostics: Diagnostic[];
}

const COMMENT_MESSAGE =
  "comments are not valid JSON; put durable annotations in a `description` field instead";

class ParseError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

/**
 * Strict RFC 8259 JSON parser with location tracking, duplicate-key rejection,
 * and a dedicated diagnostic for comments. Deliberately hand-written: the
 * format needs pointer→line/column maps for diagnostics, which JSON.parse
 * cannot provide, and must reject duplicate keys, which JSON.parse silently
 * accepts.
 */
export function parseStrictJson(text: string, file: string): ParseResult {
  const locs = new Map<string, Loc>();
  const lineStarts = computeLineStarts(text);
  let pos = 0;

  function locAt(offset: number): Loc {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
  }

  function fail(code: string, message: string, offset: number): never {
    throw new ParseError({
      severity: "error",
      code,
      file,
      message,
      loc: locAt(offset),
      span: { start: offset, end: Math.min(offset + 1, text.length) },
    });
  }

  function skipWhitespace(): void {
    for (;;) {
      while (pos < text.length && " \t\n\r".includes(text[pos]!)) pos++;
      if (text[pos] === "/" && (text[pos + 1] === "/" || text[pos + 1] === "*")) {
        fail("json.comment", COMMENT_MESSAGE, pos);
      }
      return;
    }
  }

  function expect(char: string): void {
    if (text[pos] !== char) {
      fail("json.parse", `expected \`${char}\` but found ${describeChar(text[pos])}`, pos);
    }
    pos++;
  }

  function parseValue(pointer: string): JsonValue {
    skipWhitespace();
    if (pos >= text.length) fail("json.parse", "unexpected end of input", pos);
    locs.set(pointer, locAt(pos));
    const c = text[pos]!;
    if (c === "{") return parseObject(pointer);
    if (c === "[") return parseArray(pointer);
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    fail("json.parse", `unexpected character ${describeChar(c)}`, pos);
  }

  function parseObject(pointer: string): JsonObject {
    expect("{");
    // Null-prototype, so that a JSON object is only ever the keys the file
    // actually wrote. Two distinct bugs live in the `{}` this replaces. Reading:
    // `"constructor" in obj` and `obj["constructor"]` answer from
    // `Object.prototype`, so a kit voice or a param named after one of its
    // members validated clean and then crashed — or worse, was silently ignored —
    // at render time. Writing: `result["__proto__"] = ...` on a normal object
    // hits the setter instead of creating an own property, so a `"__proto__"` key
    // disappeared between the file and the parse result. Validation therefore
    // never saw it and `fmt` wrote the file back without it, which is both a hole
    // in the closed-schema guarantee and a value `fmt` changed
    // (docs/format-spec.md §5.2). Fixing the prototype fixes the whole class;
    // nothing here special-cases a key name.
    const result = Object.create(null) as JsonObject;
    const seen = new Set<string>();
    skipWhitespace();
    if (text[pos] === "}") {
      pos++;
      return result;
    }
    for (;;) {
      skipWhitespace();
      const keyOffset = pos;
      if (text[pos] !== '"') {
        fail("json.parse", `expected a double-quoted object key but found ${describeChar(text[pos])}`, pos);
      }
      const key = parseString();
      if (seen.has(key)) {
        throw new ParseError({
          severity: "error",
          code: "json.duplicate-key",
          file,
          message: `duplicate object key "${key}"`,
          pointer: joinPointer(pointer, key),
          loc: locAt(keyOffset),
          span: { start: keyOffset, end: pos },
        });
      }
      seen.add(key);
      skipWhitespace();
      expect(":");
      result[key] = parseValue(joinPointer(pointer, key));
      skipWhitespace();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        return result;
      }
      fail("json.parse", `expected \`,\` or \`}\` but found ${describeChar(text[pos])}`, pos);
    }
  }

  function parseArray(pointer: string): JsonValue[] {
    expect("[");
    const result: JsonValue[] = [];
    skipWhitespace();
    if (text[pos] === "]") {
      pos++;
      return result;
    }
    for (;;) {
      result.push(parseValue(`${pointer}/${result.length}`));
      skipWhitespace();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "]") {
        pos++;
        return result;
      }
      fail("json.parse", `expected \`,\` or \`]\` but found ${describeChar(text[pos])}`, pos);
    }
  }

  function parseString(): string {
    expect('"');
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("json.parse", "unterminated string", pos);
      const c = text[pos]!;
      if (c === '"') {
        pos++;
        return out;
      }
      if (c === "\\") {
        pos++;
        const esc = text[pos];
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              fail("json.parse", "invalid \\u escape sequence", pos - 1);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail("json.parse", `invalid escape sequence \\${esc ?? ""}`, pos - 1);
        }
        pos++;
        continue;
      }
      if (c < " ") fail("json.parse", "unescaped control character in string", pos);
      out += c;
      pos++;
    }
  }

  function parseNumber(): number {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!match || match[0].length === 0) {
      fail("json.parse", "invalid number", pos);
    }
    const start = pos;
    pos += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      fail("json.parse", "number is outside the finite double range", start);
    }
    return value;
  }

  try {
    const value = parseValue("");
    skipWhitespace();
    if (pos < text.length) {
      fail("json.parse", `unexpected content after end of JSON value`, pos);
    }
    return { value, locs, diagnostics: [] };
  } catch (err) {
    if (err instanceof ParseError) {
      return { locs, diagnostics: [err.diagnostic] };
    }
    throw err;
  }
}

/**
 * Where each character of a JSON string value sits in the file that spells it.
 *
 * The two are not the same coordinate system, and nothing else in this codebase
 * bridges them. A steps string is parsed as its *decoded* characters, so a
 * diagnostic about it knows an index into `"x..X"`; a diagnostic's `span` is an
 * offset into the file, where that same string may be written with escapes and
 * is preceded by everything above it. `X` is one decoded character and six
 * raw ones, so the mapping is a walk rather than an addition.
 *
 * `loc` must be the location of the string value itself, which is what a
 * parse's `locs` map holds. Returns one offset per decoded character plus a
 * final one for the closing quote, so an exclusive end index maps too — or
 * `undefined` if `loc` does not name a string literal, which leaves the caller
 * with the pointer-derived location it already had.
 */
export function stringValueOffsets(text: string, loc: Loc): number[] | undefined {
  let start = 0;
  for (let line = 1; line < loc.line; line++) {
    const next = text.indexOf("\n", start);
    if (next < 0) return undefined;
    start = next + 1;
  }
  start += loc.column - 1;
  if (text[start] !== '"') return undefined;

  const offsets: number[] = [];
  let pos = start + 1;
  while (pos < text.length) {
    const char = text[pos]!;
    if (char === '"') {
      offsets.push(pos);
      return offsets;
    }
    offsets.push(pos);
    if (char !== "\\") {
      pos += 1;
      continue;
    }
    // `\uXXXX` is six raw characters for one decoded one; every other escape is
    // two. A lone trailing backslash cannot occur in text this parser accepted.
    pos += text[pos + 1] === "u" ? 6 : 2;
  }
  return undefined;
}

/** Line and column of a file offset, counted the way this parser counts them. */
export function locOfOffset(text: string, offset: number): Loc {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function describeChar(c: string | undefined): string {
  if (c === undefined) return "end of input";
  if (c === "\n") return "end of line";
  return `\`${c}\``;
}
