// @ts-check
/**
 * OCTAVE screenshot harness.
 *
 * Captures docs screenshots into docs/public/screenshots/ by driving the
 * packaged main bundle (out/main/index.js) through Playwright's Electron API.
 *
 * Usage:
 *   npm run build              # produce out/main/index.js
 *   npm run docs:screenshots
 *
 * The "with-song" steps require a real song folder. Override the path with:
 *   $env:OCTAVE_DEMO_SONG = "C:\Songs\My Song"
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
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
  dismissModals,
  maximizeWindow
} from './lib/setup.mjs'

const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'public', 'screenshots')

/**
 * @typedef {Object} Step
 * @property {string} name
 * @property {string} description
 * @property {boolean} [requiresSong]
 * @property {(page: import('playwright').Page) => Promise<void>} [run]
 */

/** @type {Step[]} */
const STEPS = [
  {
    name: 'editor-empty',
    description: 'First-launch / empty editor with toolbar visible',
    run: async (page) => {
      await page.waitForSelector('.toolbar', { timeout: 15_000 })
      await page.waitForTimeout(500)
    }
  },
  {
    name: 'settings-modal',
    description: 'Settings modal open',
    run: async (page) => {
      await page.keyboard.press('Control+,')
      await page.waitForSelector('.settings-modal', { timeout: 5_000 })
      await page.waitForTimeout(300)
    }
  },
  {
    name: 'auto-chart-modal',
    description: 'Auto-Chart modal in default state',
    run: async (page) => {
      await dismissModals(page)
      await page.locator('button:has-text("Auto-Chart")').first().click({ timeout: 5_000 })
      await page.waitForSelector('.auto-chart-modal', { timeout: 5_000 })
      await page.waitForTimeout(500)
    }
  },
  {
    name: 'auto-chart-advanced',
    description: 'Auto-Chart modal with the Advanced section expanded',
    run: async (page) => {
      const advanced = page
        .locator('.auto-chart-modal')
        .locator('button, summary')
        .filter({ hasText: /advanced/i })
        .first()
      if (await advanced.count()) {
        await advanced.click().catch(() => {})
        await page.waitForTimeout(400)
      }
    }
  },
  {
    name: 'editor-overview',
    description: 'Full editor with the demo song loaded — landing-page hero shot',
    requiresSong: true,
    run: async (page) => {
      await dismissModals(page)
      await waitForSongLoaded(page)
      await clickFirstSong(page)
      // Let the highway initialize a couple of frames.
      await page.waitForTimeout(2500)
    }
  },
  {
    name: 'editor-layout',
    description: 'Editor with the demo song loaded (used in the Editor Layout guide)',
    requiresSong: true,
    run: async (page) => {
      await page.waitForTimeout(300)
    }
  }
]

async function main() {
  await ensureMainBuild()
  await fsp.mkdir(OUTPUT_DIR, { recursive: true })

  const needsSong = STEPS.some((s) => s.requiresSong)
  /** @type {Awaited<ReturnType<typeof stageFixture>> | null} */
  let fixture = null
  if (needsSong) {
    try {
      fixture = await stageFixture([DEFAULT_DEMO_SONG])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[screenshots] could not stage demo song: ${msg}`)
      console.warn('[screenshots] song-dependent steps will be skipped.')
    }
  }
  if (!fixture) {
    fixture = await stageFixture([])
  }

  console.log('[screenshots] Launching OCTAVE…')
  const { app, page } = await launchOctave({ userData: fixture.userData })
  const bounds = await maximizeWindow(app)
  console.log(`[screenshots] window: ${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`)
  // Match the renderer viewport to the actual window so screenshots fill the frame.
  await page.setViewportSize({ width: bounds.width, height: bounds.height }).catch(() => {})

  const haveSong = needsSong && fixture.projectDir && (await fsp.readdir(fixture.projectDir)).length > 0
  if (haveSong) {
    await seedAndReload(page, { projectDir: fixture.projectDir })
  }

  let captured = 0
  let failed = 0

  for (const step of STEPS) {
    const target = path.join(OUTPUT_DIR, `${step.name}.png`)
    if (step.requiresSong && !haveSong) {
      console.log(`[screenshots] - skipping ${step.name} (no demo song available)`)
      continue
    }
    try {
      console.log(`[screenshots] -> ${step.name} - ${step.description}`)
      if (step.run) await step.run(page)
      await page.screenshot({ path: target, fullPage: false })
      captured++
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[screenshots] x ${step.name} failed: ${msg}`)
      await page.screenshot({ path: target.replace('.png', '-error.png'), fullPage: false }).catch(() => {})
    }
  }

  await app.close()
  await cleanupFixture(fixture.root)

  console.log(`[screenshots] Done. ${captured} captured, ${failed} failed.`)
  console.log(`[screenshots] Output: ${OUTPUT_DIR}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[screenshots] Fatal:', err)
  process.exit(1)
})
