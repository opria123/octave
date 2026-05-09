// @ts-check
/**
 * OCTAVE promo-video recorder.
 *
 * Drives the packaged main bundle through a ~50-second scripted tour, captures
 * the OCTAVE window via ffmpeg's gdigrab (Windows), then muxes in the demo
 * song's audio with ffmpeg-static. Output: docs/public/octave-promo.mp4.
 *
 * Notes on audio: ffmpeg's gdigrab does not capture Windows system audio.
 * Instead we mux in the source song.ogg post-hoc, delayed to match the actual
 * Space-press timestamp in the recording — so the audio stays in sync with the
 * highway during the play portion of the tour.
 *
 * Usage:
 *   npm run build       # produce out/main/index.js
 *   npm run docs:promo
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import {
  REPO_ROOT,
  DEFAULT_DEMO_SONG,
  ensureMainBuild,
  stageFixture,
  cleanupFixture,
  launchOctave,
  seedAndReload,
  waitForSongLoaded,
  clickFirstSong,
  maximizeWindow,
  setAlwaysOnTop
} from './lib/setup.mjs'

const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'public', 'octave-promo.mp4')
const FRAME_RATE = 30

/** Approximate ffmpeg gdigrab startup latency before frames begin. */
const CAPTURE_STARTUP_SEC = 1.2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {string} filePath
 * @returns {Promise<number>} duration in seconds (0 on failure)
 */
async function probeDurationSec(filePath) {
  if (!ffmpegPath) return 0
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!m) return resolve(0)
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
    })
    child.on('error', () => resolve(0))
  })
}

/** @typedef {{ pressedAtSec: number | null, pausedAtSec: number | null }} TourTiming */

/**
 * @param {import('playwright').Page} page
 * @param {() => number} captureClock seconds since capture started (with startup offset)
 * @returns {Promise<TourTiming>}
 */
async function runTour(page, captureClock) {
  /** @type {TourTiming} */
  const timing = { pressedAtSec: null, pausedAtSec: null }

  // 0–1s: brief linger so the editor is recognisable in the first frame.
  await page.waitForTimeout(1000)

  // ~1s: start playback. Record exactly when (in capture-time).
  timing.pressedAtSec = captureClock()
  await page.keyboard.press('Space')
  await page.waitForTimeout(8000)

  // ~12s: open the stems mixer popover, then close.
  const stemBtn = page.locator('.stem-mixer-button')
  if (await stemBtn.count()) {
    await stemBtn.first().click().catch(() => {})
    await page.waitForTimeout(4000)
    const close = page.locator('.stem-mixer-close')
    if (await close.count()) await close.first().click().catch(() => {})
  } else {
    await page.waitForTimeout(4000)
  }
  await page.waitForTimeout(2000)

  // ~18s: scroll the MIDI editor / bottom panel to show different lanes.
  const midi = page.locator('.midi-editor, .piano-roll, .bottom-panel').first()
  if (await midi.count()) {
    await midi.hover().catch(() => {})
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 240)
      await sleep(450)
    }
  } else {
    await page.waitForTimeout(2500)
  }
  await page.waitForTimeout(2000)

  // ~24s: open Settings modal, then close.
  await page.keyboard.press('Control+,')
  await page.waitForTimeout(3500)
  const settingsClose = page.locator('.settings-modal .settings-modal-close').first()
  if (await settingsClose.count()) await settingsClose.click().catch(() => {})
  await page.waitForTimeout(1500)

  // ~30s: open Auto-Chart modal and expand Advanced.
  const autoBtn = page.locator('button:has-text("Auto-Chart")').first()
  if (await autoBtn.count()) {
    await autoBtn.click().catch(() => {})
    await page.waitForTimeout(1500)
    const advanced = page
      .locator('.auto-chart-modal')
      .locator('button, summary')
      .filter({ hasText: /advanced/i })
      .first()
    if (await advanced.count()) await advanced.click().catch(() => {})
    await page.waitForTimeout(4000)
    const acClose = page.locator('.auto-chart-modal .settings-modal-close').first()
    if (await acClose.count()) await acClose.click().catch(() => {})
  }
  await page.waitForTimeout(1500)

  // ~38s: scroll MIDI back up to wrap.
  if (await midi.count()) {
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -240)
      await sleep(450)
    }
  }
  await page.waitForTimeout(3000)

  // ~46s: stop playback. Record the pause time so we can fade audio there.
  timing.pausedAtSec = captureClock()
  await page.keyboard.press('Space')
  await page.waitForTimeout(4500)

  return timing
}

/**
 * Spawn ffmpeg gdigrab on the desktop, cropped to the OCTAVE window region.
 * @param {string} rawPath
 * @param {{ x: number, y: number, width: number, height: number }} region
 */
function startCapture(rawPath, region) {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path')
  const w = Math.floor(region.width / 2) * 2
  const h = Math.floor(region.height / 2) * 2
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-f', 'gdigrab',
    '-framerate', String(FRAME_RATE),
    '-draw_mouse', '0',
    '-offset_x', String(region.x),
    '-offset_y', String(region.y),
    '-video_size', `${w}x${h}`,
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    rawPath
  ]
  console.log('[promo] capture:', ffmpegPath, args.join(' '))
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] })
  child.on('error', (err) => console.error('[promo] capture spawn error:', err))
  return child
}

async function stopCapture(child) {
  if (child.exitCode !== null) return
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(undefined)
    }
    child.on('exit', finish)
    if (child.exitCode !== null) return finish()
    try {
      child.stdin?.write('q')
      child.stdin?.end()
    } catch {
      try { child.kill('SIGINT') } catch { /* noop */ }
    }
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        try { child.kill('SIGTERM') } catch { /* noop */ }
      }
    }, 4000)
    setTimeout(finish, 8000)
  })
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg-static did not provide a binary path'))
    console.log('[promo] mux:', args.join(' '))
    const child = spawn(ffmpegPath, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(`ffmpeg exited ${code}`))
    )
  })
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[promo] This recorder uses gdigrab and only runs on Windows.')
    process.exit(1)
  }

  await ensureMainBuild()
  await fsp.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })

  console.log('[promo] Staging fixture…')
  const fixture = await stageFixture([DEFAULT_DEMO_SONG])
  const songName = path.basename(DEFAULT_DEMO_SONG)
  const stagedSongDir = path.join(fixture.projectDir, songName)
  const songOgg = path.join(stagedSongDir, 'song.ogg')
  if (!fs.existsSync(songOgg)) throw new Error(`[promo] Expected song.ogg at ${songOgg}`)

  console.log('[promo] Launching OCTAVE…')
  const { app, page } = await launchOctave({ userData: fixture.userData })

  // Fill the primary display so nothing is clipped, then capture that exact region.
  await maximizeWindow(app)
  await page.waitForTimeout(500)

  await seedAndReload(page, { projectDir: fixture.projectDir })
  await waitForSongLoaded(page)
  await clickFirstSong(page)

  // Re-maximize after the reload (renderer can resize on first mount).
  const region = await maximizeWindow(app)
  console.log(`[promo] capture region: ${region.width}x${region.height} @ (${region.x},${region.y})`)

  // Pin OCTAVE on top so gdigrab doesn't capture whatever else the user has
  // open in the same screen region. Windows refuses cross-process focus
  // stealing, so plain focus()/moveTop() can lose to other foreground apps.
  await setAlwaysOnTop(app, true)
  await page.waitForTimeout(1500)

  const rawPath = path.join(fixture.root, 'capture.mp4')

  console.log('[promo] Starting capture…')
  const captureChild = startCapture(rawPath, region)
  await sleep(1500)
  const captureT0 = process.hrtime.bigint()
  const captureClock = () => Number(process.hrtime.bigint() - captureT0) / 1e9 + CAPTURE_STARTUP_SEC

  console.log('[promo] Recording tour…')
  const tourStart = Date.now()
  const timing = await runTour(page, captureClock)
  console.log(`[promo] Tour finished in ${((Date.now() - tourStart) / 1000).toFixed(1)}s.`)
  if (timing.pressedAtSec !== null) {
    console.log(`[promo] Space pressed at capture t=${timing.pressedAtSec.toFixed(2)}s — audio aligned there.`)
  }

  console.log('[promo] Stopping capture…')
  await stopCapture(captureChild)
  await sleep(500)

  await setAlwaysOnTop(app, false).catch(() => {})

  console.log('[promo] Closing app…')
  await app.close().catch(() => {})

  if (!fs.existsSync(rawPath)) throw new Error(`[promo] Capture file missing: ${rawPath}`)
  const rawStat = await fsp.stat(rawPath)
  console.log(`[promo] Raw capture: ${rawPath} (${(rawStat.size / 1024 / 1024).toFixed(2)} MB)`)

  // Audio: play song.ogg from t=0, delayed to land on the actual Space-press
  // timestamp in the capture, fade out at the pause moment (or near EOF).
  const audioDelaySec = Math.max(0, timing.pressedAtSec ?? 5)
  const audioDelayMs = Math.round(audioDelaySec * 1000)
  const rawDuration = await probeDurationSec(rawPath)
  const fadeOutSt = timing.pausedAtSec ?? Math.max(audioDelaySec + 5, rawDuration - 3)
  const fadeOutDur = 1.5
  const filter =
    `[1:a]asetpts=PTS-STARTPTS,` +
    `adelay=${audioDelayMs}|${audioDelayMs},` +
    `afade=t=out:st=${fadeOutSt.toFixed(2)}:d=${fadeOutDur}[a]`

  await fsp.rm(OUTPUT_PATH, { force: true })
  await runFfmpeg([
    '-y',
    '-i', rawPath,
    '-i', songOgg,
    '-filter_complex', filter,
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    OUTPUT_PATH
  ])

  const outStat = await fsp.stat(OUTPUT_PATH)
  console.log(`[promo] Wrote ${OUTPUT_PATH} (${(outStat.size / 1024 / 1024).toFixed(2)} MB)`)

  await cleanupFixture(fixture.root)
  console.log('[promo] Done.')
}

main().catch((err) => {
  console.error('[promo] Fatal:', err)
  process.exit(1)
})
