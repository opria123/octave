type AlbumArtUpdate = { folderPath: string; dataUrl: string }
type AlbumArtListener = (update: AlbumArtUpdate) => void

const listeners = new Set<AlbumArtListener>()

export function publishAlbumArtUpdate(update: AlbumArtUpdate): void {
  for (const listener of listeners) listener(update)
}

export function subscribeAlbumArtUpdates(listener: AlbumArtListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
