export interface LyricCue {
  startSec: number
  endSec?: number
  text: string
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, '')
}

function parseTimestampToSeconds(raw: string): number | null {
  const value = raw.trim().replace(',', '.')
  if (!value) return null

  const parts = value.split(':')
  if (parts.length === 1) {
    const sec = Number(parts[0])
    return Number.isFinite(sec) ? sec : null
  }

  if (parts.length === 2) {
    const mm = Number(parts[0])
    const ss = Number(parts[1])
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return null
    return mm * 60 + ss
  }

  if (parts.length === 3) {
    const hh = Number(parts[0])
    const mm = Number(parts[1])
    const ss = Number(parts[2])
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null
    return hh * 3600 + mm * 60 + ss
  }

  return null
}

export function parseLrc(content: string): LyricCue[] {
  const cues: LyricCue[] = []
  const lines = content.split(/\r?\n/)

  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:[\.,]\d{1,3})?)\]/g)]
    if (matches.length === 0) continue

    const text = line.replace(/\[[^\]]+\]/g, '').trim()
    if (!text) continue

    for (const match of matches) {
      const ts = parseTimestampToSeconds(match[1])
      if (ts == null) continue
      cues.push({ startSec: ts, text })
    }
  }

  cues.sort((a, b) => a.startSec - b.startSec)

  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endSec == null || cues[i].endSec! <= cues[i].startSec) {
      cues[i].endSec = Math.max(cues[i].startSec + 0.05, cues[i + 1].startSec)
    }
  }

  return cues
}

export function parseSrt(content: string): LyricCue[] {
  const cues: LyricCue[] = []
  const blocks = content
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim())
    if (lines.length < 2) continue

    const timeLineIndex = lines[0].includes('-->') ? 0 : 1
    const timeLine = lines[timeLineIndex]
    if (!timeLine || !timeLine.includes('-->')) continue

    const [startRaw, endRaw] = timeLine.split('-->').map((p) => p.trim())
    const startSec = parseTimestampToSeconds(startRaw)
    const endSec = parseTimestampToSeconds(endRaw)
    if (startSec == null) continue

    const textLines = lines.slice(timeLineIndex + 1)
    const text = textLines
      .join(' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!text) continue

    cues.push({
      startSec,
      endSec: endSec != null && endSec > startSec ? endSec : undefined,
      text: decodeXmlEntities(stripTags(text))
    })
  }

  cues.sort((a, b) => a.startSec - b.startSec)
  return cues
}

export function parseTtml(content: string): LyricCue[] {
  const cues: LyricCue[] = []

  // Match <p begin="..." end="...">...</p> and variants with attributes in any order
  const pMatches = [...content.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]

  for (const match of pMatches) {
    const attrs = match[1] || ''
    const body = match[2] || ''

    const beginMatch = attrs.match(/\bbegin\s*=\s*"([^"]+)"/i)
    if (!beginMatch) continue

    const endMatch = attrs.match(/\bend\s*=\s*"([^"]+)"/i)
    const durMatch = attrs.match(/\bdur\s*=\s*"([^"]+)"/i)

    const startSec = parseTimestampToSeconds(beginMatch[1])
    if (startSec == null) continue

    let endSec: number | undefined
    if (endMatch) {
      const parsed = parseTimestampToSeconds(endMatch[1])
      if (parsed != null && parsed > startSec) endSec = parsed
    } else if (durMatch) {
      const parsedDur = parseTimestampToSeconds(durMatch[1])
      if (parsedDur != null && parsedDur > 0) endSec = startSec + parsedDur
    }

    const text = decodeXmlEntities(
      stripTags(body.replace(/<br\s*\/?>/gi, ' '))
        .replace(/\s+/g, ' ')
        .trim()
    )

    if (!text) continue
    cues.push({ startSec, endSec, text })
  }

  cues.sort((a, b) => a.startSec - b.startSec)
  return cues
}

export function parseLyricImport(content: string, extension: string): LyricCue[] {
  const ext = extension.toLowerCase().replace(/^\./, '')
  if (ext === 'lrc') return parseLrc(content)
  if (ext === 'srt') return parseSrt(content)
  if (ext === 'ttml' || ext === 'xml') return parseTtml(content)
  return []
}
