// @ts-check
/**
 * OCTAVE screenshot harness — uses Playwright's Electron driver to launch the
 * packaged main bundle and capture documentation screenshots.
 *
 * Usage:
 *   npm run build              # produce out/main/index.js
 *   npm run docs:screenshots   # this script
 */

import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const MAIN_ENTRY = path.join(REPO_ROOT, 'out', 'main', 'index.js')
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'public', 'screenshots')

const VIEWPORT = { width: 1600, height: 1100 }

/**
 * @typedef {Object} Step
 * @property {string} name
 * @property {string} description
 * @property {(page: import('playwright').Page) => Promise<void>} [run]
 */

/**
 * Helper: dismiss any open modal so the next step starts from a clean state.
 */
async function dismissModals(page) {
  // Both Settings and Auto-Chart modals use a `.settings-modal-close` X button.
  // Click any visible close button, then settle.
  for (let i = 0; i < 3; i++) {
    const closeBtn = await page.$('.settings-modal-close')
    if (!closeBtn) break
    await closeBtn.click().catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(150)
}

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
    description: 'Settings modal open on the General tab',
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
      // Modal still open from previous step.
      const advanced = page.locator('.auto-chart-modal').locator('button, summary').filter({ hasText: /advanced/i }).first()
      if (await advanced.count()) {
        await advanced.click().catch(() => {})
        await page.waitForTimeout(400)
      }
    }
  }
  // Add more steps here — see scripts/screenshots/README.md
]

async function ensureBuild() {
  try {
    await fs.access(MAIN_ENTRY)
  } catch {
    console.error(`[screenshots] Main bundle not found at ${MAIN_ENTRY}.`)
    console.error('[screenshots] Run "npm run build" first.')
    process.exit(1)
  }
}

async function main() {
  await ensureBuild()
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  console.log('[screenshots] Launching OCTAVE…')
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      OCTAVE_SCREENSHOT_MODE: '1',
      ELECTRON_DISABLE_GPU_SANDBOX: '1'
    }
  })

  const page = await app.firstWindow()
  await page.setViewportSize(VIEWPORT)
  await page.waitForLoadState('domcontentloaded')

  let captured = 0
  let failed = 0

  for (const step of STEPS) {
    const target = path.join(OUTPUT_DIR, `${step.name}.png`)
    try {
      console.log(`[screenshots] → ${step.name} — ${step.description}`)
      if (step.run) await step.run(page)
      await page.screenshot({ path: target, fullPage: false })
      captured++
    } catch (err) {
      failed++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[screenshots] ✗ ${step.name} failed: ${msg}`)
      // Still try to capture whatever the window currently shows
      await page.screenshot({ path: target.replace('.png', '-error.png'), fullPage: false }).catch(() => {})
    }
  }

  await app.close()
  console.log(`[screenshots] Done. ${captured} captured, ${failed} failed.`)
  console.log(`[screenshots] Output: ${OUTPUT_DIR}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[screenshots] Fatal:', err)
  process.exit(1)
})
