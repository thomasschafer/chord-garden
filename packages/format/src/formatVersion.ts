/**
 * `project.json` `format` versions this tool understands.
 *
 * Its own module because both the loader and the semantic validator need these
 * numbers and the loader imports the validator, so a constant living in either
 * one would be a cycle.
 *
 * Reading is backward-compatible by policy: a document older than
 * `SUPPORTED_FORMAT` stays valid and is never migrated on open, and only a
 * *newer* format is rejected (docs/format-spec.md §10). What a version gates is
 * therefore which features a document may use, not whether it can be read at
 * all — hence `EFFECTS_MIN_FORMAT` rather than a single "current" number.
 */

/** The newest `format` this tool can read. */
export const SUPPORTED_FORMAT = 2;

/**
 * The `format` a track's `effects` chain requires.
 *
 * Effects are a breaking addition rather than an additive one, so they bump the
 * version: a format-1 tool given a document with an effect chain would validate
 * it, ignore the chain, and render audio missing a delay the author put there.
 * Silently dropping part of the music is exactly what a version number exists to
 * prevent, so a format-1 document carrying `effects` is an error and says so.
 */
export const EFFECTS_MIN_FORMAT = 2;
