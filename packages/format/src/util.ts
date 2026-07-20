export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j]!;
  }
  return prev[cols - 1]!;
}

/**
 * "Did you mean" support: returns the closest candidate within an edit
 * distance of 2, or undefined when nothing is plausibly close.
 */
export function closestMatch(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const d = levenshtein(name, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
