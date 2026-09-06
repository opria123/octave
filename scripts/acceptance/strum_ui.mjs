/* eslint-disable @typescript-eslint/explicit-function-return-type -- This executable harness is JavaScript. */
// Real Electron UI acceptance. All application state is isolated in a fresh directory.
import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const {
  STRUM_ROOT,
  STRUM_PYTHON,
  ACCEPTANCE_CATALOG_ROOT,
  ACCEPTANCE_OUTPUT,
  ACCEPTANCE_POSITIVE_ROOT
} = process.env
if (![STRUM_ROOT, STRUM_PYTHON, ACCEPTANCE_CATALOG_ROOT, ACCEPTANCE_OUTPUT].every(Boolean)) {
  throw new Error('Set STRUM_ROOT, STRUM_PYTHON, ACCEPTANCE_CATALOG_ROOT, ACCEPTANCE_OUTPUT')
}
const privateRoots = [
  STRUM_ROOT,
  STRUM_PYTHON,
  ACCEPTANCE_CATALOG_ROOT,
  ACCEPTANCE_OUTPUT,
  ACCEPTANCE_POSITIVE_ROOT
].filter(Boolean)
await fs.mkdir(ACCEPTANCE_OUTPUT, { mode: 0o700 })
const report = { format: 'octave-strum-ui-acceptance/v1', quality_claim: false, stages: [] }
const launchOptions = {
  args: [
    // Launch the repository application (equivalent to `electron .`) so the
    // harness runs as a developer build. Passing the compiled main file
    // directly marks Electron as packaged and wrongly triggers managed-runtime
    // setup instead of using the explicitly configured local STRUM checkout.
    repo,
    `--user-data-dir=${path.join(ACCEPTANCE_OUTPUT, 'user-data')}`,
    '--no-sandbox',
    '--disable-gpu-sandbox'
  ],
  env: {
    ...process.env,
    OCTAVE_SCREENSHOT_MODE: '1',
    OCTAVE_STRUM_SOURCE_DIR: STRUM_ROOT,
    OCTAVE_STRUM_PYTHON: STRUM_PYTHON,
    OMP_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
    WANDB_MODE: 'disabled'
  }
}
async function resolveFirstWindow(app) {
  // Electron can create the initial BrowserWindow before Playwright registers
  // its `window` event. Prefer the already-known window so the acceptance
  // harness cannot wait forever for an event that has already happened.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [page] = app.windows()
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return app.firstWindow()
}

let app = await electron.launch(launchOptions)
let page = await resolveFirstWindow(app)
page.setDefaultTimeout(60_000)
async function record(name) {
  report.stages.push({ name, status: 'passed' })
  await fs.writeFile(path.join(ACCEPTANCE_OUTPUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`${name}: passed`)
}
async function chooseFolder(folder) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, folder)
}
async function waitTerminal(before, state) {
  await page.waitForFunction(
    (before) =>
      window.acceptanceEvents
        .slice(before)
        .some((event) => ['succeeded', 'failed', 'cancelled'].includes(event.state)),
    before,
    { timeout: 300_000 }
  )
  const events = await page.evaluate((before) => window.acceptanceEvents.slice(before), before)
  const terminal = events.find((event) =>
    ['succeeded', 'failed', 'cancelled'].includes(event.state)
  )
  if (terminal?.state !== state) throw new Error(`Unexpected terminal state: ${terminal?.state}`)
  if (privateRoots.some((root) => JSON.stringify(events).includes(root)))
    throw new Error('Private root leaked to progress')
}
try {
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.acceptanceEvents = []
    window.api.onTrainingProgress((event) => window.acceptanceEvents.push(event))
  })
  await page.getByTitle('Open the STRUM training wizard').click()
  await page
    .getByRole('navigation', { name: 'Training steps' })
    .getByRole('button', { name: 'curate', exact: true })
    .click()
  await chooseFolder(path.dirname(ACCEPTANCE_CATALOG_ROOT))
  await page.locator('.dataset-catalog-parent').getByRole('button').click()
  await page
    .locator('.dataset-catalog-select')
    .filter({ hasText: path.basename(ACCEPTANCE_CATALOG_ROOT) })
    .click()
  await page
    .getByRole('navigation', { name: 'Training steps' })
    .getByRole('button', { name: 'prepare', exact: true })
    .click()
  await chooseFolder(STRUM_ROOT)
  await page.getByRole('button', { name: 'Choose STRUM checkout', exact: true }).click()
  await page.getByLabel(/^Pipeline/).selectOption('chart_transform.five_lane/v1')
  await page.getByLabel(/^Instrument/).selectOption('guitar')
  await page.getByLabel(/^Target Difficulty/).selectOption('Hard')
  await record('runtime-and-catalog-inspection')
  let before = await page.evaluate(() => window.acceptanceEvents.length)
  await page.getByRole('button', { name: /^Prepare .* Dataset/ }).click()
  await waitTerminal(before, 'succeeded')
  await page.getByRole('heading', { name: 'Prepared task views' }).waitFor()
  await page.screenshot({ path: path.join(ACCEPTANCE_OUTPUT, 'prepared.png') })
  await record('prepare-completed')
  await page
    .getByRole('navigation', { name: 'Training steps' })
    .getByRole('button', { name: 'train', exact: true })
    .click()
  await page.getByLabel('Model Id', { exact: true }).fill('acceptance-ui-transform')
  await page.getByLabel('Epochs', { exact: true }).fill('1')
  await page.getByLabel('Hidden Dim', { exact: true }).fill('8')
  await page.getByLabel('Device', { exact: true }).first().fill('cpu')
  before = await page.evaluate(() => window.acceptanceEvents.length)
  await page.getByRole('button', { name: /^Start local .* run/ }).click()
  await waitTerminal(before, 'succeeded')
  await page.getByRole('heading', { name: 'Recent runs' }).waitFor()
  await record('training-terminal-and-candidate-registration')
  const completedCount = await page.evaluate(
    async () => (await window.api.listTrainingArtifacts()).runs.length
  )
  await page.getByLabel('Model Id', { exact: true }).fill('acceptance-ui-cancelled')
  await page.getByLabel('Epochs', { exact: true }).fill('100')
  before = await page.evaluate(() => window.acceptanceEvents.length)
  await page.getByRole('button', { name: /^Start local .* run/ }).click()
  await page.waitForFunction(
    (before) => window.acceptanceEvents.slice(before).some((event) => event.state === 'running'),
    before
  )
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click()
  await waitTerminal(before, 'cancelled')
  const cancelledArtifacts = await page.evaluate(() => window.api.listTrainingArtifacts())
  if (
    cancelledArtifacts.runs.length !== completedCount ||
    !cancelledArtifacts.jobs.some((job) => job.state === 'cancelled')
  )
    throw new Error('Cancelled run was registered or not persisted')
  await record('training-cancellation-without-candidate')

  before = await page.evaluate(() => window.acceptanceEvents.length)
  await page.getByRole('button', { name: 'Evaluate candidate', exact: true }).click()
  await waitTerminal(before, 'succeeded')
  const qualityGate = await page.evaluate(
    (before) =>
      window.acceptanceEvents.slice(before).find((event) => event.state === 'succeeded')?.result
        ?.result?.quality_gate_status,
    before
  )
  if (qualityGate !== 'failed')
    throw new Error('Expected actual failed canonical quality evaluation')
  report.real_catalog_quality_gate_status = qualityGate
  await record('evaluation-completed')
  before = await page.evaluate(() => window.acceptanceEvents.length)
  await page.getByLabel('Profile Id', { exact: true }).fill('acceptance-ui-transform-profile')
  await page.getByRole('button', { name: 'Package profile', exact: true }).click()
  await waitTerminal(before, 'failed')
  await record('quality-gate-rejected-package')
  await page.screenshot({ path: path.join(ACCEPTANCE_OUTPUT, 'evaluated.png') })
  const artifacts = await page.evaluate(() => window.api.listTrainingArtifacts())
  if (
    !artifacts.runs.length ||
    artifacts.runs.some((run) => run.deployable) ||
    artifacts.profiles.length
  )
    throw new Error('Raw candidate incorrectly deployable')
  if (privateRoots.some((root) => JSON.stringify(artifacts).includes(root)))
    throw new Error('Private root leaked to artifacts')
  if (!artifacts.jobs.some((job) => job.state === 'failed'))
    throw new Error('Failed job missing from history')
  await record('opaque-nondeployable-artifacts-and-failure-history')
  if (ACCEPTANCE_POSITIVE_ROOT) {
    await page
      .getByRole('navigation', { name: 'Training steps' })
      .getByRole('button', { name: 'deploy', exact: true })
      .click()
    await chooseFolder(path.join(ACCEPTANCE_POSITIVE_ROOT, 'package'))
    await page.getByRole('button', { name: 'Choose model-bundle folder', exact: true }).click()
    await page.locator('.training-deploy-runs').getByRole('button').first().click()
    await page
      .getByRole('button', { name: 'Validate & save as Auto Chart default', exact: true })
      .click()
    await page.getByRole('heading', { name: 'Use the learned transform', exact: true }).waitFor()
    await record('positive-packaged-profile-default')
    const pair = JSON.parse(
      (
        await fs.readFile(path.join(ACCEPTANCE_POSITIVE_ROOT, 'prepared/pairs.jsonl'), 'utf8')
      ).split('\n')[0]
    )
    const source = path.join(
      ACCEPTANCE_POSITIVE_ROOT,
      'catalog/assets/sha256',
      pair.notes_midi_sha256,
      'notes.mid'
    )
    const destination = path.join(ACCEPTANCE_OUTPUT, 'charts')
    await fs.mkdir(destination)
    await app.evaluate(
      ({ dialog }, selections) => {
        let index = 0
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selections[index++]] })
      },
      [source, destination]
    )
    await page.getByRole('button', { name: 'Transform MIDI', exact: true }).click()
    await page.getByText(/Created notes.mid and run.json in/).waitFor({ timeout: 300_000 })
    const outputs = await fs.readdir(destination)
    if (outputs.length !== 1) throw new Error('Unexpected transform output count')
    for (const name of ['notes.mid', 'run.json'])
      await fs.access(path.join(destination, outputs[0], name))
    const provenance = await fs.readFile(path.join(destination, outputs[0], 'song.ini'), 'utf8')
    if (
      !provenance.includes('strum_generated = true') ||
      !provenance.includes('dataset_opt_in = false')
    )
      throw new Error('Missing generated-chart provenance guard')
    await page.screenshot({ path: path.join(ACCEPTANCE_OUTPUT, 'transformed.png') })
    await record('positive-octave-transform-midi')
  }
  await app.close()
  app = await electron.launch(launchOptions)
  page = await resolveFirstWindow(app)
  await page.waitForLoadState('domcontentloaded')
  const restored = await page.evaluate(() => window.api.listTrainingArtifacts())
  if (
    !restored.jobs.some((job) => job.state === 'failed') ||
    !restored.jobs.some((job) => job.state === 'cancelled') ||
    restored.runs.length !== completedCount
  )
    throw new Error('Terminal job history did not survive restart')
  if (ACCEPTANCE_POSITIVE_ROOT && !restored.profiles.some((profile) => profile.isDefault))
    throw new Error('Validated default did not survive restart')
  if (privateRoots.some((root) => JSON.stringify(restored).includes(root)))
    throw new Error('Private root leaked after restart')
  await record('restart-preserves-history-and-default')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure_type = error.name
  await fs
    .writeFile(
      path.join(ACCEPTANCE_OUTPUT, 'failure-private.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => 'UI closed')
    )
    .catch(() => {})
  await page
    .screenshot({ path: path.join(ACCEPTANCE_OUTPUT, 'failure-private.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(path.join(ACCEPTANCE_OUTPUT, 'report.json'), JSON.stringify(report, null, 2))
  await app.close()
}
