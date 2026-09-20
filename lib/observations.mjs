function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Builds a collector's `observations` array from the raw {id, message} entries
 * gathered during a run, mirroring how the planning and product collectors finalize
 * their `warnings` arrays today (`[...new Set(warnings)].sort(compareText)`). The
 * other collectors leave `warnings` unsorted; observations are stricter on purpose.
 * See docs/decisions/2026-09-20-warnings-vs-observations.md section 2.2.
 *
 * De-duplication is keyed on the exact (id, message) pair, not on `id` alone: the
 * same observation id raised for two different files (two different messages) is
 * kept as two entries, since each names a distinct fact about the repository. Two
 * entries reduce to one only when both fields match exactly, the same way a repeated
 * warning string collapses to one warning today.
 *
 * The result is sorted by id, then by message, so bundle output stays deterministic
 * regardless of collection order. The input array is read, never mutated, and each
 * output entry is a fresh { id, message } object, so extra fields on an input entry
 * are dropped rather than carried through.
 *
 * Sanitizing `message` happens later, when the whole bundle is sanitized at export
 * (see `recursivelySanitize` in export.mjs) -- this helper only builds and
 * de-duplicates the list.
 */
export function buildObservations(entries) {
  const seen = new Set();
  const deduplicated = [];

  for (const { id, message } of entries) {
    const key = `${id}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push({ id, message });
  }

  return deduplicated.sort(
    (left, right) => compareText(left.id, right.id) || compareText(left.message, right.message),
  );
}
