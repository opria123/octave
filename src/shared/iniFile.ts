// song.ini reading/writing. Kept out of the main entry point so the parsing
// rules can be unit tested without booting Electron.

// Only a value that is numeric in its entirety becomes a number. `parseFloat`
// is deliberately avoided here: it happily reads a leading number out of a
// title like "99 Problems" (-> 99) or "7 Nation Army" (-> 7), which then flows
// through the app as a number where a string is expected.
const NUMERIC_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

// Parse INI file content
export function parseIniFile(content: string): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  const lines = content.split(/\r?\n/)
  let inSongSection = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Section header
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSongSection = trimmed.toLowerCase() === '[song]'
      continue
    }

    // Key-value pair
    if (inSongSection && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=')
      const value = valueParts.join('=').trim()

      result[key.trim()] = NUMERIC_VALUE.test(value) ? Number(value) : value
    }
  }

  return result
}

// Serialize metadata to INI format
export function serializeIniFile(metadata: Record<string, unknown>): string {
  const lines = ['[song]']

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null && value !== '') {
      lines.push(`${key} = ${value}`)
    }
  }

  return lines.join('\n')
}
