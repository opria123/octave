import { describe, expect, it, vi } from 'vitest'
import { publishAlbumArtUpdate, subscribeAlbumArtUpdates } from './albumArtEvents'

describe('album art updates', () => {
  it('notifies mounted consumers and supports unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAlbumArtUpdates(listener)
    const update = { folderPath: '/songs/example', dataUrl: 'data:image/jpeg;base64,art' }
    publishAlbumArtUpdate(update)
    expect(listener).toHaveBeenCalledWith(update)

    unsubscribe()
    publishAlbumArtUpdate(update)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
