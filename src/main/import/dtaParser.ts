export interface DtaSong {
  shortname: string
  name: string
  artist?: string
  album?: string
  year?: number
  genre?: string
  vocalsGender?: string
  previewStart: number
  previewEnd: number
  ranks: Record<string, number>
  vols: number[]
  pans: number[]
  channels: Record<string, number[]>
}

export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < input.length) {
    const char = input[i]
    if (char === ';') {
      // Line comment: skip until newline
      while (i < input.length && input[i] !== '\n') {
        i++
      }
    } else if (char === '(' || char === ')') {
      tokens.push(char)
      i++
    } else if (char === '"') {
      // String token
      let str = '"'
      i++
      while (i < input.length) {
        if (input[i] === '\\' && input[i + 1] === '"') {
          str += '\\"'
          i += 2
        } else if (input[i] === '"') {
          str += '"'
          i++
          break
        } else {
          str += input[i]
          i++
        }
      }
      tokens.push(str)
    } else if (char === ' ' || char === '\r' || char === '\n' || char === '\t') {
      i++
    } else {
      // Symbol or number
      let sym = ''
      while (
        i < input.length &&
        input[i] !== '(' &&
        input[i] !== ')' &&
        input[i] !== '"' &&
        input[i] !== ';' &&
        !/\s/.test(input[i])
      ) {
        sym += input[i]
        i++
      }
      tokens.push(sym)
    }
  }
  return tokens
}

export type DtaNode = string | DtaNode[]

export function parseTokens(tokens: string[]): DtaNode[] {
  let index = 0

  function parseExpr(): DtaNode {
    const token = tokens[index]
    if (token === '(') {
      index++ // skip '('
      const list: DtaNode[] = []
      while (index < tokens.length && tokens[index] !== ')') {
        list.push(parseExpr())
      }
      if (tokens[index] === ')') {
        index++ // skip ')'
      }
      return list
    } else if (token === ')') {
      index++
      return []
    } else {
      index++
      return token
    }
  }

  const root: DtaNode[] = []
  while (index < tokens.length) {
    root.push(parseExpr())
  }
  return root
}

function cleanSymbol(val: DtaNode | undefined): string {
  if (typeof val !== 'string') return ''
  let sym = val.trim()
  if (sym.startsWith("'") && sym.endsWith("'")) {
    sym = sym.slice(1, -1)
  }
  return sym
}

function findNode(node: DtaNode, key: string): DtaNode[] | null {
  if (!Array.isArray(node)) return null
  for (const child of node) {
    if (
      Array.isArray(child) &&
      child.length > 0 &&
      typeof child[0] === 'string' &&
      cleanSymbol(child[0]) === key
    ) {
      return child
    }
  }
  return null
}

function cleanString(val: DtaNode | undefined): string {
  if (typeof val !== 'string') return ''
  const str = val.trim()
  if (str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1).replace(/\\"/g, '"')
  }
  if (str.startsWith("'") && str.endsWith("'")) {
    return str.slice(1, -1)
  }
  return str
}

function cleanNumber(val: DtaNode | undefined): number {
  if (typeof val !== 'string') return 0
  let numStr = val.trim()
  if (numStr.startsWith("'") && numStr.endsWith("'")) {
    numStr = numStr.slice(1, -1)
  }
  return Number(numStr) || 0
}

function getFlatList(node: DtaNode[] | null): number[] {
  if (!node) return []
  const mapVal = (v: DtaNode): number => {
    if (typeof v !== 'string') return 0
    let clean = v.trim()
    if (clean.startsWith("'") && clean.endsWith("'")) {
      clean = clean.slice(1, -1)
    }
    return Number(clean) || 0
  }
  if (node.length > 1 && Array.isArray(node[1])) {
    return node[1].map(mapVal)
  }
  return node.slice(1).map(mapVal)
}

export function parseDta(dtaContent: string): Record<string, DtaSong> {
  const tokens = tokenize(dtaContent)
  const ast = parseTokens(tokens)
  const songs: Record<string, DtaSong> = {}

  for (const expr of ast) {
    if (!Array.isArray(expr) || expr.length === 0) continue
    const shortnameRaw = expr[0]
    if (typeof shortnameRaw !== 'string') continue
    const shortname = cleanSymbol(shortnameRaw)

    const info: DtaSong = {
      shortname,
      name: 'Unknown Title',
      ranks: {},
      vols: [],
      pans: [],
      channels: {},
      previewStart: 0,
      previewEnd: 30
    }

    const nameNode = findNode(expr, 'name')
    if (nameNode) info.name = cleanString(nameNode[1])

    const artistNode = findNode(expr, 'artist')
    if (artistNode) info.artist = cleanString(artistNode[1])

    const albumNode = findNode(expr, 'album_name')
    if (albumNode) info.album = cleanString(albumNode[1])

    const yearNode = findNode(expr, 'year_released')
    if (yearNode) info.year = cleanNumber(yearNode[1])

    const genreNode = findNode(expr, 'genre')
    if (genreNode) {
      info.genre = cleanString(genreNode[1]).replace(/^genre_/, '')
    }

    const vocalGenderNode = findNode(expr, 'vocal_gender')
    if (vocalGenderNode) {
      info.vocalsGender =
        typeof vocalGenderNode[1] === 'string' ? cleanSymbol(vocalGenderNode[1]) : undefined
    }

    const previewNode = findNode(expr, 'preview')
    if (previewNode) {
      info.previewStart = cleanNumber(previewNode[1]) / 1000
      info.previewEnd = cleanNumber(previewNode[2]) / 1000
    }

    // Ranks
    const rankNode = findNode(expr, 'rank')
    if (rankNode) {
      const items =
        rankNode.length === 2 && Array.isArray(rankNode[1]) && Array.isArray(rankNode[1][0])
          ? rankNode[1]
          : rankNode.slice(1)

      for (const r of items) {
        if (Array.isArray(r) && r.length > 1 && typeof r[0] === 'string') {
          info.ranks[cleanSymbol(r[0])] = cleanNumber(r[1])
        }
      }
    }

    // Vols/Pans/Channels from song node
    const songNode = findNode(expr, 'song')
    if (songNode) {
      const volsNode = findNode(songNode, 'vols')
      if (volsNode) info.vols = getFlatList(volsNode)

      const pansNode = findNode(songNode, 'pans')
      if (pansNode) info.pans = getFlatList(pansNode)

      const tracksNode = findNode(songNode, 'tracks')
      if (tracksNode) {
        const mappingList = tracksNode[1]
        if (Array.isArray(mappingList)) {
          for (const t of mappingList) {
            if (Array.isArray(t) && t.length > 1) {
              const instRaw = t[0]
              if (typeof instRaw === 'string') {
                const inst = cleanSymbol(instRaw)
                const chans = t[1]
                if (Array.isArray(chans)) {
                  info.channels[inst] = chans.map((c) => {
                    if (typeof c !== 'string') return 0
                    let clean = c.trim()
                    if (clean.startsWith("'") && clean.endsWith("'")) {
                      clean = clean.slice(1, -1)
                    }
                    return Number(clean) || 0
                  })
                } else if (typeof chans === 'string') {
                  let clean = chans.trim()
                  if (clean.startsWith("'") && clean.endsWith("'")) {
                    clean = clean.slice(1, -1)
                  }
                  info.channels[inst] = [Number(clean) || 0]
                }
              }
            }
          }
        }
      }
    }

    songs[shortname] = info
  }

  return songs
}
