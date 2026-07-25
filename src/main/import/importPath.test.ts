import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ImportCancelledError, prepareSongDirectory } from './importPath'

describe('prepareSongDirectory', () => {
  let libraryDir: string

  beforeEach(async () => {
    libraryDir = await mkdtemp(join(tmpdir(), 'octave-import-path-'))
  })

  afterEach(async () => {
    await rm(libraryDir, { recursive: true, force: true })
  })

  it('creates a numbered folder when Create New is applied to a conflict', async () => {
    const initial = await prepareSongDirectory(libraryDir, 'Artist - Song')
    await initial!.finalize()

    const duplicate = await prepareSongDirectory(
      libraryDir,
      'Artist - Song',
      async () => 'create-new'
    )
    expect(duplicate!.destinationDir).toBe(join(libraryDir, 'Artist - Song (2)'))
  })

  it('skips a conflicting song without modifying it', async () => {
    const initial = await prepareSongDirectory(libraryDir, 'Artist - Song')
    await writeFile(join(initial!.workingDir, 'song.ini'), 'original')
    await initial!.finalize()

    expect(await prepareSongDirectory(libraryDir, 'Artist - Song', async () => 'skip')).toBeNull()
    expect(await readFile(join(initial!.destinationDir, 'song.ini'), 'utf8')).toBe('original')
  })

  it('stages overwrite content and replaces the original only on finalize', async () => {
    const initial = await prepareSongDirectory(libraryDir, 'Artist - Song')
    await writeFile(join(initial!.workingDir, 'song.ini'), 'original')
    await initial!.finalize()

    const overwrite = await prepareSongDirectory(
      libraryDir,
      'Artist - Song',
      async () => 'overwrite'
    )
    await writeFile(join(overwrite!.workingDir, 'song.ini'), 'replacement')
    expect(await readFile(join(initial!.destinationDir, 'song.ini'), 'utf8')).toBe('original')

    await overwrite!.finalize()
    expect(await readFile(join(initial!.destinationDir, 'song.ini'), 'utf8')).toBe('replacement')
    expect((await readdir(libraryDir)).some((name) => name.includes('.octave-'))).toBe(false)
  })

  it('cancels the operation when requested', async () => {
    const initial = await prepareSongDirectory(libraryDir, 'Artist - Song')
    await initial!.finalize()

    await expect(
      prepareSongDirectory(libraryDir, 'Artist - Song', async () => 'cancel')
    ).rejects.toBeInstanceOf(ImportCancelledError)
  })
})
