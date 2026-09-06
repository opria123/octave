import { createHash } from 'crypto'

/**
 * A package-entry identity is deliberately local to OCTAVE.  It binds a
 * parsed chart to the exact container bytes and a parser-defined locator, but
 * is never emitted in renderer IPC or written to a catalog.
 */
export function packageEntryIdentity(
  kind: 'sng' | 'rb3con' | 'zip',
  containerSha256: string,
  entryLocator: string,
  midiSha256: string
): string {
  return createHash('sha256')
    .update(`${kind}\u0000${containerSha256}\u0000${entryLocator}\u0000${midiSha256}`, 'utf8')
    .digest('hex')
}

/**
 * The locator is an adapter-private parsing key, not a source pathname.  Keep
 * it normalized so inventory and materialization cannot disagree based on
 * case or path separators.
 */
export function normalizedPackageEntryLocator(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}
