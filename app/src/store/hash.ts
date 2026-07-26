import { hashContent } from "@chord-garden/engine/live";

/**
 * Content hash of a document's text, over UTF-8 bytes.
 *
 * The engine's hash, not a second one: the sidecar hashes the file on disk with
 * exactly this function, and two implementations of "the hash of these bytes"
 * would be a precondition that fails for no reason.
 */
export function hashText(text: string): string {
  return hashContent(new TextEncoder().encode(text));
}
