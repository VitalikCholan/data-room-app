function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/**
 * Produces "invoice (2).pdf" for the KEEP_BOTH upload strategy.
 * `takenLowercased` must be lower-cased by the caller because the database index
 * is on lower(name) — comparing case-sensitively here would generate a name the
 * insert then rejects.
 */
export function resolveAvailableName(
  desired: string,
  takenLowercased: Set<string>,
): string {
  if (!takenLowercased.has(desired.toLowerCase())) return desired
  const [stem, ext] = splitExtension(desired)
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!takenLowercased.has(candidate.toLowerCase())) return candidate
  }
  throw new Error(`Could not find a free name for ${desired}`)
}
