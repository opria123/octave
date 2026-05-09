// @ts-check
/**
 * Shared helpers for the OCTAVE screenshot + promo-video harnesses.
 *
 *  - Spins up an isolated Electron user-data dir (so the run never touches
 *    the user's real OCTAVE settings).
 *  - Stages a fixture project folder containing one or more song folders.
 *  - Pre-seeds renderer localStorage so the app auto-loads the fixture on
 *    startup.
 */

import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
export const MAIN_ENTRY = path.join(REPO_ROOT, 'out', 'main', 'index.js')

/** Default song to load. Override with OCTAVE_DEMO_SONG env var. */
export const DEFAULT_DEMO_SONG =
  process.env.OCTAVE_DEMO_SONG ||
  'F:\\projects\\data\\training_songs\\C3\\Post Malone and Swae Lee - Sunflower'

export async function ensureMainBuild() {
  try {
    await fsp.access(MAIN_ENTRY)
  } catch {
    console.error(`[harness] Main bundle not found at ${MAIN_ENTRY}`)
    console.error('[harness] Run "npm run build" first.')
    process.exit(1)
  }
}

/**
 * Create a temp fixture directory containing the given song folder(s),
 * plus an isolated userData dir for Electron. Returns paths.
 *
 * The song folder is copied (not linked) so the bundle is self-contained
 * even on filesystems that don't support junctions/symlinks.
 *
 * @param {string[]} songFolders Absolute paths to song folders to include.
 */
export async function stageFixture(songFolders) {
  const stamp = Date.now()
  const root = path.join(os.tmpdir(), `octave-harness-${stamp}`)
  const userData = path.join(root, 'user-data')
  const projectDir = path.join(root, 'project')
  await fsp.mkdir(userData, { recursive: true })
  await fsp.mkdir(projectDir, { recursive: true })

  for (const src of songFolders) {
    if (!fs.existsSync(src)) {
      throw new Error(`[harness] song folder does not exist: ${src}`)
    }
    const name = path.basename(src)
    const dest = path.join(projectDir, name)
    // Recursive copy. We avoid junctions/symlinks because the main process'
    // folder:scan handler uses fs.readdir({ withFileTypes: true }) and a
    // junction reports isDirectory() === false, so it would be skipped.
    await fsp.cp(src, dest, { recursive: true })
  }

  return { root, userData, projectDir }
}

export async function cleanupFixture(root) {
  try {
    await fsp.rm(root, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[harness] cleanup failed for ${root}:`, err)
  }
}

/**
 * Launch the packaged main bundle with an isolated userData dir.
 * @param {{ userData: string, recordVideo?: { dir: string, size?: { width: number, height: number } } }} opts
 */
export async function launchOctave({ userData, recordVideo }) {
  /** @type {Parameters<typeof electron.launch>[0]} */
  const launchOpts = {
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu-sandbox'
    ],
    env: {
      ...process.env,
      OCTAVE_SCREENSHOT_MODE: '1',
      ELECTRON_DISABLE_GPU_SANDBOX: '1'
    }
  }
  if (recordVideo) launchOpts.recordVideo = recordVideo

  const app = await electron.launch(launchOpts)
  const page = await app.firstWindow()
  if (process.env.OCTAVE_HARNESS_VERBOSE) {
    page.on('console', (msg) => console.log(`[renderer:${msg.type()}]`, msg.text()))
    page.on('pageerror', (err) => console.log('[renderer:error]', err.message))
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  return { app, page }
}

/**
 * Pre-seed the renderer's localStorage with a settings blob that points
 * `lastOpenedFolder` at the staged project directory, then reload so the
 * Project Explorer auto-loads it.
 */
export async function seedAndReload(page, { projectDir }) {
  const settings = {
    state: {
      autosaveEnabled: true,
      autosaveIntervalMs: 2000,
      theme: 'dark',
      highwaySpeed: 1.0,
      audioLatencyMs: 0,
      volume: 0.6,
      pianoRollZoom: 2.0,
      snapDivision: 4,
      lastOpenedFolder: projectDir,
      leftyFlip: false,
      enableAutoChart: true,
      autoChartOutputDir: undefined
    },
    version: 0
  }
  await page.evaluate((s) => {
    localStorage.setItem('chart-editor-settings', s)
  }, JSON.stringify(settings))
  await page.reload({ waitUntil: 'domcontentloaded' })
}

/** Wait until the Project Explorer has at least one song row. */
export async function waitForSongLoaded(page, { timeoutMs = 30_000 } = {}) {
  await page.waitForSelector('.explorer-song-item', { timeout: timeoutMs })
  // Give the song's MIDI a moment to deserialize and render.
  await page.waitForTimeout(1500)
}

/** Click the first (or named) song row. */
export async function clickFirstSong(page) {
  await page.locator('.explorer-song-item').first().click()
  await page.waitForTimeout(800)
}

/**
 * Resize the OCTAVE window to (almost) fill the primary display's work area
 * and bring it to the front. Returns the resulting outer bounds — useful for
 * cropping a screen capture.
 *
 * @param {import('playwright').ElectronApplication} app
 */
export async function maximizeWindow(app) {
  const bounds = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return null
    const display = screen.getPrimaryDisplay()
    // Leave a small margin so the taskbar / window chrome shadow has room.
    const margin = 0
    const wa = display.workArea
    const target = {
      x: wa.x + margin,
      y: wa.y + margin,
      width: wa.width - margin * 2,
      height: wa.height - margin * 2
    }
    w.setBounds(target)
    w.show()
    w.focus()
    w.moveTop()
    return w.getBounds()
  })
  if (!bounds) throw new Error('[harness] no BrowserWindow found to maximize')
  return bounds
}

/**
 * Pin/unpin the OCTAVE window so it stays above any user-owned windows during
 * a screen capture. Windows blocks cross-process foreground stealing, so
 * BrowserWindow.focus() alone is not enough — setAlwaysOnTop bypasses that.
 *
 * @param {import('playwright').ElectronApplication} app
 * @param {boolean} on
 */
export async function setAlwaysOnTop(app, on) {
  await app.evaluate(async ({ BrowserWindow }, value) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return
    // 'screen-saver' level beats most fullscreen apps and toolbars.
    w.setAlwaysOnTop(value, 'screen-saver')
    if (value) {
      w.show()
      w.moveTop()
      w.focus()
    }
  }, on)
}

/** Dismiss any modal currently on screen. */
export async function dismissModals(page) {
  for (let i = 0; i < 3; i++) {
    const closeBtn = await page.$('.settings-modal-close')
    if (!closeBtn) break
    await closeBtn.click().catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(150)
}
