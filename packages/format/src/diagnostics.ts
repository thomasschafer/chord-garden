export type Severity = "error" | "warning" | "info";

export interface Loc {
  line: number;
  column: number;
}

export interface Span {
  start: number;
  end: number;
}

/**
 * The structured diagnostic contract shared by `validate`, the sidecar's
 * `diagnosticsChanged` push, and all tests. Tests assert on `code`, never on
 * `message` prose. At least one locator (pointer, span, or loc) must be present.
 */
export interface Diagnostic {
  severity: Severity;
  code: string;
  file: string;
  message: string;
  pointer?: string;
  span?: Span;
  loc?: Loc;
  suggestion?: string;
}

export class DiagnosticCollector {
  readonly items: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  addAll(diagnostics: Iterable<Diagnostic>): void {
    for (const d of diagnostics) {
      this.items.push(d);
    }
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  /** Stable output order: by file, then line, then pointer, then code. */
  sorted(): Diagnostic[] {
    return [...this.items].sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      const aLine = a.loc?.line ?? 0;
      const bLine = b.loc?.line ?? 0;
      if (aLine !== bLine) return aLine - bLine;
      const aPtr = a.pointer ?? "";
      const bPtr = b.pointer ?? "";
      if (aPtr !== bPtr) return aPtr < bPtr ? -1 : 1;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });
  }
}

export function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function joinPointer(base: string, segment: string | number): string {
  return `${base}/${escapePointerSegment(String(segment))}`;
}
