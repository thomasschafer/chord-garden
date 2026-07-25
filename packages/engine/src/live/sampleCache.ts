/**
 * Content hash of raw bytes: FNV-1a over two lanes with different offset bases,
 * plus the length, printed as hex.
 *
 * Not cryptographic and not trying to be — nothing here is a security boundary.
 * It exists so that replacing `samples/kick.wav` produces a different key and the
 * decoded audio for the old bytes cannot be served for the new file (PLAN.md §14),
 * and so two kit voices pointing at identical content decode once. Two lanes and
 * the length are cheap insurance against the accidental collisions a single
 * 32-bit lane would eventually hand us across a project's lifetime of edits.
 */
export function hashContent(bytes: ArrayBufferView): string {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < view.length; index++) {
    const byte = view[index]!;
    low = Math.imul(low ^ byte, 0x01000193);
    high = Math.imul(high ^ byte, 0x85ebca6b);
  }
  const length = view.length.toString(16);
  return `${(low >>> 0).toString(16).padStart(8, "0")}${(high >>> 0).toString(16).padStart(8, "0")}-${length}`;
}

/**
 * Decoded samples addressed by content, with project-relative paths as the index
 * into them.
 *
 * Both sides of the worklet boundary use this: the main thread to decide whether
 * it must fetch and decode a file at all, the worklet to hold what it has been
 * given. Keying the payload by hash rather than by path is what makes a sample
 * swap correct in both directions — a file whose bytes change gets a new entry
 * even though its path is the same, and a file renamed with identical bytes
 * reuses the decode.
 */
export class SampleStore<T> {
  private readonly byPath = new Map<string, string>();
  private readonly byHash = new Map<string, { value: T; paths: Set<string> }>();

  /** Content hash currently associated with `path`. */
  hashOf(path: string): string | undefined {
    return this.byPath.get(path);
  }

  get(path: string): T | undefined {
    const hash = this.byPath.get(path);
    if (hash === undefined) return undefined;
    return this.byHash.get(hash)?.value;
  }

  /** Anything already stored under this exact content, from any path. */
  getByHash(hash: string): T | undefined {
    return this.byHash.get(hash)?.value;
  }

  /** True when `path` holds nothing, or holds different content than `hash`. */
  needsUpdate(path: string, hash: string): boolean {
    return this.byPath.get(path) !== hash;
  }

  /**
   * Bind `path` to `hash`. `value` is only used when this content is new, so a
   * caller that already has the decode can pass a thunk and skip the work.
   */
  set(path: string, hash: string, value: () => T): void {
    const previous = this.byPath.get(path);
    if (previous === hash) return;
    if (previous !== undefined) this.release(path, previous);
    const existing = this.byHash.get(hash);
    if (existing === undefined) {
      this.byHash.set(hash, { value: value(), paths: new Set([path]) });
    } else {
      existing.paths.add(path);
    }
    this.byPath.set(path, hash);
  }

  /** Forget `path`; the content goes too once no path refers to it. */
  invalidate(path: string): void {
    const hash = this.byPath.get(path);
    if (hash === undefined) return;
    this.release(path, hash);
    this.byPath.delete(path);
  }

  /** Distinct decoded payloads held, i.e. the real memory cost. */
  get contentCount(): number {
    return this.byHash.size;
  }

  get pathCount(): number {
    return this.byPath.size;
  }

  private release(path: string, hash: string): void {
    const entry = this.byHash.get(hash);
    if (entry === undefined) return;
    entry.paths.delete(path);
    if (entry.paths.size === 0) this.byHash.delete(hash);
  }
}
