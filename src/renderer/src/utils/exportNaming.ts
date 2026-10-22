export type ExportFormat = 'sng' | 'rb3con' | 'chart'

export interface ExportFormatInfo {
  id: ExportFormat
  title: string
  icon: string
  description: string
  /** Label for the name field: a file for .sng / CON, a folder for .chart. */
  nameLabel: string
  namePlaceholder: string
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  {
    id: 'sng',
    title: 'Clone Hero (.sng)',
    icon: '🎸',
    description:
      'Standard encrypted archive packaging notes, audio stems, and art into a single file container.',
    nameLabel: 'File Name',
    namePlaceholder: 'e.g. My_Song.sng'
  },
  {
    id: 'chart',
    title: 'Clone Hero (.chart folder)',
    icon: '📝',
    description:
      'Plain-text notes.chart with song.ini, audio stems, and art in a song folder ready to drop into Clone Hero, YARG, or Moonscraper.',
    nameLabel: 'Folder Name',
    namePlaceholder: 'e.g. My Song'
  },
  {
    id: 'rb3con',
    title: 'Rockband 3 RB3con',
    icon: '💿',
    description:
      'Xbox 360 Rock Band 3 STFS container package containing MIDI charts, MOGG audio stems, and catalog metadata.',
    nameLabel: 'File Name',
    namePlaceholder: 'e.g. My_Song_rb3con'
  }
]

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/** Strips any export-format suffix the user may have typed or we added earlier. */
export function stripExportSuffix(name: string): string {
  let base = name.trim()
  // Loop so "Song.sng_rb3con" style leftovers collapse to the bare name.
  for (;;) {
    const lower = base.toLowerCase()
    if (lower.endsWith('.sng')) base = base.slice(0, -4)
    else if (lower.endsWith('_rb3con')) base = base.slice(0, -7)
    else if (lower.endsWith('.chart')) base = base.slice(0, -6)
    else break
  }
  return base.trim()
}

/**
 * Normalises whatever is in the name field into the file (or folder) name the
 * chosen format expects. Falls back to the song title when the field is empty.
 */
export function resolveExportName(
  rawName: string,
  format: ExportFormat,
  songTitle: string | undefined
): string {
  let base = stripExportSuffix(rawName)
  if (!base) base = sanitizeFilename(songTitle || 'song') || 'song'
  switch (format) {
    case 'sng':
      return `${base}.sng`
    case 'rb3con':
      return `${base}_rb3con`
    case 'chart':
      return base
  }
}

export function joinExportPath(folder: string, name: string): string {
  const separator = folder.includes('\\') ? '\\' : '/'
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`
}
