import { app, BrowserWindow, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { dirname, join } from 'path'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync, mkdirSync, createWriteStream, type WriteStream } from 'fs'
import { parseAutoChartProgressLine } from './progress'
import { ensureLinuxBootstrappedPython, isLinuxBootstrapTarget } from './linuxBootstrap'
import type { AutoChartProgressEvent, AutoChartRunOptions, AutoChartRunResult, AutoChartStage } from './types'

const EVENT_PREFIX = '__OCTAVE_EVENT__'
const PYTHON_CHECK_TIMEOUT_MS = 10_000
const NO_OUTPUT_WARN_MS = 30_000
const HEARTBEAT_TICK_MS = 15_000

/**
 * Locate the bundled ffmpeg-static binary so we can prepend its directory to
 * the worker's PATH. Whisper / yt-dlp / demucs all shell out to `ffmpeg`, and
 * many user machines don't have it on PATH.
 */
function resolveBundledFfmpegDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require('ffmpeg-static') as string | null
    if (!ffmpegPath) return null
    // electron-builder asarUnpack rewrites the path inside app.asar to
    // app.asar.unpacked. ffmpeg-static handles this itself by returning the
    // unpacked path at runtime, so dirname() is enough.
    let resolved = ffmpegPath
    if (resolved.includes(`app.asar${require('path').sep}`)) {
      resolved = resolved.replace(`app.asar${require('path').sep}`, `app.asar.unpacked${require('path').sep}`)
    }
    if (!existsSync(resolved)) return null
    return dirname(resolved)
  } catch {
    return null
  }
}

type PythonCommand = {
  command: string
  baseArgs: string[]
}

type RunningJob = {
  process: ReturnType<typeof spawn>
  payloadPath: string
}

const runningJobs = new Map<string, RunningJob>()

const STAGE_PERCENT: Partial<Record<AutoChartStage, number>> = {
  bootstrap: 5,
  download: 20,
  separation: 30,
  drums: 45,
  guitar: 58,
  bass: 68,
  vocals: 78,
  keys: 86,
  merge: 94,
  complete: 100,
  error: 0
}

const STAGE_SEQUENCE: AutoChartStage[] = [
  'bootstrap',
  'download',
  'separation',
  'drums',
  'guitar',
  'bass',
  'vocals',
  'keys',
  'merge',
  'complete',
  'error'
]

const STAGE_HEARTBEAT_CEILING: Partial<Record<AutoChartStage, number>> = {
  bootstrap: 19,
  download: 24,
  separation: 44,
  drums: 57,
  guitar: 67,
  bass: 77,
  vocals: 85,
  keys: 93,
  merge: 98,
  complete: 100,
  error: 100
}

function getStageRank(stage: AutoChartStage): number {
  const index = STAGE_SEQUENCE.indexOf(stage)
  return index === -1 ? 0 : index
}

function logStrum(runId: string, message: string, detail?: unknown): void {
  const prefix = `[STRUM][${runId}]`
  if (detail !== undefined) {
    console.log(prefix, message, detail)
    return
  }
  console.log(prefix, message)
}

function warnStrum(runId: string, message: string, detail?: unknown): void {
  const prefix = `[STRUM][${runId}]`
  if (detail !== undefined) {
    console.warn(prefix, message, detail)
    return
  }
  console.warn(prefix, message)
}

function isVerboseDebug(): boolean {
  return process.env.OCTAVE_STRUM_DEBUG === '1' || !app.isPackaged
}

function getStrumLogsDir(): string {
  return join(app.getPath('userData'), 'logs', 'strum')
}

export function getStrumLogsFolder(): string {
  return getStrumLogsDir()
}

export async function openStrumLogsFolder(): Promise<void> {
  const dir = getStrumLogsDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
  await shell.openPath(dir)
}

function openRunLog(runId: string): WriteStream | null {
  try {
    const dir = getStrumLogsDir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `${stamp}_${runId}.log`)
    const stream = createWriteStream(file, { flags: 'a' })
    stream.write(`# STRUM run log\n# runId=${runId}\n# started=${new Date().toISOString()}\n# packaged=${app.isPackaged}\n# platform=${process.platform}-${process.arch}\n# logPath=${file}\n\n`)
    return stream
  } catch (err) {
    console.warn('[STRUM] failed to open run log:', err)
    return null
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function getWorkerRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'strum')
  }

  return join(process.cwd(), 'resources', 'strum')
}

function getWorkerScriptPath(): string {
  return join(getWorkerRoot(), 'strum_worker.py')
}

function isStrumSourceRoot(sourceRoot: string): boolean {
  return existsSync(join(sourceRoot, 'scripts', 'batch_pipeline.py'))
}

function getDevStrumSourceOverride(): string | undefined {
  const configured = process.env.OCTAVE_STRUM_SOURCE_DIR?.trim()
  if (configured && isStrumSourceRoot(configured)) {
    return configured
  }

  const candidates = [
    join(process.cwd(), '..', 'strum'),
    join(process.cwd(), 'strum'),
    join(process.cwd(), '..', 'autocharter'),
    join(process.cwd(), 'autocharter')
  ]

  return candidates.find(isStrumSourceRoot)
}

export function getStrumRequirementsPath(): string {
  return join(getWorkerRoot(), 'requirements.txt')
}

function getBundledPythonRoot(): string {
  return join(process.resourcesPath, 'resources', 'python')
}

function getBundledRuntimeHome(): string {
  return join(getBundledPythonRoot(), `${process.platform}-${process.arch}`, 'python')
}

function getBundledPythonMetadata(): { executable: string; sitePackages: string } | null {
  const metadataPath = join(getBundledPythonRoot(), `${process.platform}-${process.arch}`, 'metadata.json')
  if (!existsSync(metadataPath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(metadataPath, 'utf-8')) as { executable: string; sitePackages: string }
  } catch {
    return null
  }
}

function getBundledPythonCandidates(): PythonCommand[] {
  const metadata = getBundledPythonMetadata()
  if (metadata) {
    return [
      {
        command: join(getBundledRuntimeHome(), metadata.executable),
        baseArgs: []
      }
    ]
  }

  const key = `${process.platform}-${process.arch}`
  const runtimeRoot = getBundledPythonRoot()
  const candidatesByPlatform: Record<string, PythonCommand[]> = {
    'win32-x64': [
      { command: join(runtimeRoot, 'win32-x64', 'python', 'python.exe'), baseArgs: [] }
    ],
    'win32-arm64': [
      { command: join(runtimeRoot, 'win32-arm64', 'python', 'python.exe'), baseArgs: [] }
    ],
    'darwin-x64': [
      { command: join(runtimeRoot, 'darwin-x64', 'python', 'bin', 'python3'), baseArgs: [] }
    ],
    'darwin-arm64': [
      { command: join(runtimeRoot, 'darwin-arm64', 'python', 'bin', 'python3'), baseArgs: [] }
    ],
    'linux-x64': [
      { command: join(runtimeRoot, 'linux-x64', 'python', 'bin', 'python3'), baseArgs: [] }
    ],
    'linux-arm64': [
      { command: join(runtimeRoot, 'linux-arm64', 'python', 'bin', 'python3'), baseArgs: [] }
    ]
  }

  return candidatesByPlatform[key] ?? []
}

function getBundledPythonEnv(): NodeJS.ProcessEnv {
  // On Linux the runtime is a venv created at first launch (see
  // linuxBootstrap.ts), not a self-contained bundled prefix. The venv's
  // own pyvenv.cfg already points the interpreter at the right site-packages,
  // and forcing PYTHONHOME/PYTHONPATH from a bundle metadata.json would
  // break it. Only return the bundled env when a metadata.json exists.
  const metadata = getBundledPythonMetadata()
  const pathSeparator = process.platform === 'win32' ? ';' : ':'
  // Prepend bundled ffmpeg dir to PATH so Whisper / yt-dlp / demucs can find
  // ffmpeg without the user installing it system-wide.
  const ffmpegDir = resolveBundledFfmpegDir()
  const existingPath = process.env.PATH ?? process.env.Path ?? ''
  const augmentedPath = ffmpegDir
    ? `${ffmpegDir}${pathSeparator}${existingPath}`
    : existingPath

  if (!metadata) {
    return {
      ...process.env,
      PATH: augmentedPath,
      PYTHONUTF8: '1',
      OCTAVE_PACKAGED: '1'
    }
  }

  const runtimeHome = getBundledRuntimeHome()
  const sitePackages = join(runtimeHome, metadata.sitePackages)
  const pythonPath = process.env.PYTHONPATH

  return {
    ...process.env,
    PATH: augmentedPath,
    PYTHONHOME: runtimeHome,
    PYTHONPATH: pythonPath ? `${sitePackages}${pathSeparator}${pythonPath}` : sitePackages,
    PYTHONUTF8: '1',
    OCTAVE_PACKAGED: '1'
  }
}

async function commandExists(candidate: PythonCommand): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile(candidate.command, [...candidate.baseArgs, '--version'], { timeout: PYTHON_CHECK_TIMEOUT_MS }, (error) => {
      resolve(!error)
    })
  })
}

async function findPythonCommand(runId?: string): Promise<PythonCommand> {
  if (app.isPackaged) {
    if (isLinuxBootstrapTarget()) {
      const requirementsPath = getStrumRequirementsPath()
      if (!existsSync(requirementsPath)) {
        throw new Error(`STRUM requirements file not found at ${requirementsPath}`)
      }
      const venvPython = await ensureLinuxBootstrappedPython(requirementsPath, runId)
      return { command: venvPython, baseArgs: [] }
    }

    const bundledCandidates = getBundledPythonCandidates()
    for (const candidate of bundledCandidates) {
      if (existsSync(candidate.command) && await commandExists(candidate)) {
        return candidate
      }
    }

    throw new Error(
      'A bundled Python runtime was not found for this packaged build. '
      + `Expected it under ${getBundledPythonRoot()} for ${process.platform}-${process.arch}.`
    )
  }

  const configured = process.env.OCTAVE_STRUM_PYTHON?.trim()
  const candidates: PythonCommand[] = []

  if (configured) {
    candidates.push({ command: configured, baseArgs: [] })
  }

  if (process.platform === 'win32') {
    candidates.push({ command: 'py', baseArgs: ['-3.11'] })
    candidates.push({ command: 'py', baseArgs: ['-3.10'] })
    candidates.push({ command: 'py', baseArgs: ['-3'] })
  }

  candidates.push({ command: 'python3', baseArgs: [] })
  candidates.push({ command: 'python', baseArgs: [] })

  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return candidate
    }
  }

  throw new Error(
    'A compatible Python runtime for development was not found. Set OCTAVE_STRUM_PYTHON, or install Python 3.10/3.11 and ensure it is available on PATH.'
  )
}

function splitLines(chunk: string, remainder: string): { lines: string[]; remainder: string } {
  const combined = remainder + chunk
  const parts = combined.split(/\r?\n/)
  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) ?? ''
  }
}

function getFallbackPercent(stage: unknown): number | undefined {
  if (typeof stage !== 'string') return undefined
  return STAGE_PERCENT[stage as AutoChartStage]
}

function normalizeGlobalPercent(stage: AutoChartStage, stagePercent: number): number {
  // Worker stage percentages are stage-local (0-100). Map them into global progress
  // ranges so UI progress never appears stuck at 100% before completion.
  if (stage === 'complete') return 100
  if (stage === 'error') return 0

  const floor = STAGE_PERCENT[stage]
  const ceiling = STAGE_HEARTBEAT_CEILING[stage]
  if (typeof floor !== 'number' || typeof ceiling !== 'number' || ceiling <= floor) {
    return Math.max(0, Math.min(100, Math.round(stagePercent)))
  }

  const clamped = Math.max(0, Math.min(100, stagePercent)) / 100
  return Math.round(floor + (ceiling - floor) * clamped)
}

function handleStructuredEvent(
  line: string,
  completion: { result?: AutoChartRunResult; error?: string },
  onProgress?: (event: AutoChartProgressEvent) => void
): boolean {
  if (!line.startsWith(EVENT_PREFIX)) {
    return false
  }

  try {
    const payload = JSON.parse(line.slice(EVENT_PREFIX.length)) as Record<string, unknown>
    const kind = payload.kind
    if (kind === 'progress') {
      const runId = String(payload.runId ?? '')
      const message = String(payload.message ?? '')
      const inferred = message ? parseAutoChartProgressLine(runId, message) : null
      const percentFromPayload = typeof payload.percent === 'number' ? payload.percent : undefined
      const payloadStage = String(payload.stage ?? '') as AutoChartStage
      const stage = payloadStage === 'bootstrap' && inferred?.stage && inferred.stage !== 'bootstrap'
        ? inferred.stage
        : (payloadStage || inferred?.stage || 'bootstrap') as AutoChartStage
      const percent = typeof percentFromPayload === 'number'
        ? normalizeGlobalPercent(stage, percentFromPayload)
        : (inferred?.percent ?? getFallbackPercent(stage))

      const progressEvent = {
        ...payload,
        runId,
        stage,
        message,
        percent
      } satisfies AutoChartProgressEvent

      broadcast('strum:progress', progressEvent)
      onProgress?.(progressEvent)
      return true
    }

    if (kind === 'complete') {
      completion.result = {
        success: payload.success === true,
        outputDir: String(payload.outputDir ?? ''),
        songFolders: Array.isArray(payload.songFolders) ? payload.songFolders.map(String) : [],
        errors: Array.isArray(payload.errors) ? payload.errors.map(String) : []
      }
      return true
    }

    if (kind === 'error') {
      completion.error = String(payload.message ?? 'STRUM worker failed.')
      broadcast('strum:error', payload)
      return true
    }
  } catch {
    completion.error = 'STRUM worker emitted malformed structured output.'
  }

  return true
}

function handlePlainLine(runId: string, line: string): void {
  const parsed = parseAutoChartProgressLine(runId, line)
  if (parsed) {
    broadcast('strum:progress', parsed)
  }
}

export async function runAutoChart(options: Omit<AutoChartRunOptions, 'cacheDir'>): Promise<AutoChartRunResult> {
  const python = await findPythonCommand(options.runId)
  const runId = options.runId
  const cacheDir = join(app.getPath('userData'), 'cache', 'strum')
  const workerScript = getWorkerScriptPath()
  if (!existsSync(workerScript)) {
    throw new Error(`STRUM worker script was not found at ${workerScript}`)
  }

  await mkdir(cacheDir, { recursive: true })
  const payload: AutoChartRunOptions = {
    ...options,
    runId,
    cacheDir
  }

  const payloadPath = join(app.getPath('temp'), `octave-strum-${runId}.json`)
  await writeFile(payloadPath, JSON.stringify(payload), 'utf-8')

  broadcast('strum:progress', {
    runId,
    stage: 'bootstrap',
    message: 'Starting STRUM auto-chart run...',
    percent: 0
  } satisfies AutoChartProgressEvent)

  return await new Promise<AutoChartRunResult>((resolve, reject) => {
    const verboseDebug = isVerboseDebug()
    const devEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: '1'
    }
    const sourceOverride = getDevStrumSourceOverride()
    if (sourceOverride) {
      devEnv.OCTAVE_STRUM_SOURCE_DIR = sourceOverride
    }

    logStrum(runId, 'Starting worker process', {
      python: python.command,
      pythonArgs: python.baseArgs,
      workerScript,
      cacheDir,
      outputDir: options.outputDir,
      sourceOverride: sourceOverride ?? 'none',
      packaged: app.isPackaged
    })

    const child = spawn(
      python.command,
      [...python.baseArgs, getWorkerScriptPath(), '--payload-file', payloadPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: app.isPackaged
          ? getBundledPythonEnv()
          : devEnv
      }
    )

    runningJobs.set(runId, { process: child, payloadPath })
    logStrum(runId, `Worker spawned (pid=${child.pid ?? 'unknown'})`)

    const runLog = openRunLog(runId)
    const writeLog = (line: string): void => {
      if (!runLog) return
      try { runLog.write(line.endsWith('\n') ? line : `${line}\n`) } catch { /* noop */ }
    }
    if (runLog) {
      writeLog(`# python=${python.command} args=${JSON.stringify(python.baseArgs)}`)
      writeLog(`# workerScript=${workerScript}`)
      writeLog(`# cacheDir=${cacheDir}`)
      writeLog(`# outputDir=${options.outputDir}`)
      writeLog(`# pid=${child.pid ?? 'unknown'}`)
      writeLog('')
      logStrum(runId, `Run log: ${(runLog as unknown as { path?: string }).path ?? getStrumLogsDir()}`)
    }

    let stdoutRemainder = ''
    let stderrRemainder = ''
    const completion: { result?: AutoChartRunResult; error?: string } = {}
    let lastOutputAt = Date.now()
    let lastProgressPercent = 0
    let lastProgressStage: AutoChartStage = 'bootstrap'

    const heartbeat = setInterval(() => {
      const silenceMs = Date.now() - lastOutputAt
      if (silenceMs < NO_OUTPUT_WARN_MS) return

      if (lastProgressStage === 'separation' && lastProgressPercent < 30) {
        lastProgressPercent = 30
      }

      const stageCeiling = STAGE_HEARTBEAT_CEILING[lastProgressStage] ?? 95
      if (lastProgressPercent < stageCeiling) {
        lastProgressPercent = Math.min(stageCeiling, lastProgressPercent + 1)
      }

      const silenceSec = Math.floor(silenceMs / 1000)
      warnStrum(runId, `No worker output for ${silenceSec}s (stage=${lastProgressStage}, percent=${lastProgressPercent}%)`)
      broadcast('strum:progress', {
        runId,
        stage: lastProgressStage,
        message: `Still processing... no new STRUM logs for ${silenceSec}s (this stage can take several minutes).`,
        percent: lastProgressPercent
      } satisfies AutoChartProgressEvent)
    }, HEARTBEAT_TICK_MS)

    const consume = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf-8')
      lastOutputAt = Date.now()
      // Always tee raw output to the per-run log file so packaged builds
      // can be debugged without devtools.
      if (runLog) {
        try { runLog.write(text) } catch { /* noop */ }
      }
      const split = splitLines(text, stream === 'stdout' ? stdoutRemainder : stderrRemainder)
      if (stream === 'stdout') {
        stdoutRemainder = split.remainder
      } else {
        stderrRemainder = split.remainder
      }

      for (const line of split.lines) {
        if (verboseDebug) {
          logStrum(runId, `${stream}> ${line}`)
        }

        if (!handleStructuredEvent(line, completion, (event) => {
          const incomingRank = getStageRank(event.stage)
          const currentRank = getStageRank(lastProgressStage)

          if (event.stage !== 'error' && event.stage !== 'complete' && incomingRank < currentRank) {
            return
          }

          if (incomingRank > currentRank) {
            lastProgressStage = event.stage
            if (typeof event.percent === 'number') {
              lastProgressPercent = event.percent
            } else {
              lastProgressPercent = getFallbackPercent(event.stage) ?? lastProgressPercent
            }
            return
          }

          lastProgressStage = event.stage
          if (typeof event.percent === 'number') {
            lastProgressPercent = Math.max(lastProgressPercent, event.percent)
          }
        })) {
          const parsed = parseAutoChartProgressLine(runId, line)
          if (parsed) {
            const incomingRank = getStageRank(parsed.stage)
            const currentRank = getStageRank(lastProgressStage)
            if (parsed.stage !== 'error' && parsed.stage !== 'complete' && incomingRank < currentRank) {
              continue
            }

            if (incomingRank > currentRank) {
              lastProgressStage = parsed.stage
              if (typeof parsed.percent === 'number') {
                lastProgressPercent = parsed.percent
              }
            } else {
              lastProgressStage = parsed.stage
              if (typeof parsed.percent === 'number') {
                lastProgressPercent = Math.max(lastProgressPercent, parsed.percent)
              }
            }

            if (typeof parsed.percent === 'number') {
              parsed.percent = lastProgressPercent
            }
            broadcast('strum:progress', parsed)
          }
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer) => consume(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, 'stderr'))

    child.on('error', async (error) => {
      clearInterval(heartbeat)
      warnStrum(runId, 'Worker process error', error)
      writeLog(`# WORKER ERROR: ${error.message}`)
      if (runLog) { try { runLog.end() } catch { /* noop */ } }
      runningJobs.delete(runId)
      try {
        await unlink(payloadPath)
      } catch {
        // Ignore payload cleanup failures.
      }
      reject(error)
    })

    child.on('close', async (code, signal) => {
      clearInterval(heartbeat)
      logStrum(runId, `Worker closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      writeLog(`# WORKER CLOSED code=${code ?? 'null'} signal=${signal ?? 'null'} at=${new Date().toISOString()}`)
      if (runLog) { try { runLog.end() } catch { /* noop */ } }
      runningJobs.delete(runId)
      try {
        await unlink(payloadPath)
      } catch {
        // Ignore payload cleanup failures.
      }

      if (stdoutRemainder) {
        if (verboseDebug) {
          logStrum(runId, `stdout(remainder)> ${stdoutRemainder}`)
        }
        handleStructuredEvent(stdoutRemainder, completion) || handlePlainLine(runId, stdoutRemainder)
      }
      if (stderrRemainder) {
        if (verboseDebug) {
          logStrum(runId, `stderr(remainder)> ${stderrRemainder}`)
        }
        handleStructuredEvent(stderrRemainder, completion) || handlePlainLine(runId, stderrRemainder)
      }

      if (signal === 'SIGTERM') {
        reject(new Error('STRUM auto-chart run was cancelled.'))
        return
      }

      if (completion.result) {
        resolve(completion.result)
        return
      }

      const detail = completion.error ?? `STRUM worker exited with code ${code ?? 'unknown'}.`
      reject(new Error(detail))
    })
  })
}

export async function cancelAutoChart(runId: string): Promise<boolean> {
  const job = runningJobs.get(runId)
  if (!job) return false
  const killed = job.process.kill('SIGTERM')
  if (!killed) return false

  try {
    await unlink(job.payloadPath)
  } catch {
    // Ignore payload cleanup failures.
  }

  runningJobs.delete(runId)
  broadcast('strum:progress', {
    runId,
    stage: 'error',
    message: 'Auto-chart run cancelled.'
  } satisfies AutoChartProgressEvent)
  return true
}

/**
 * Synchronously terminate every still-running STRUM worker. Intended for the
 * Electron `before-quit` hook so orphan Python processes don't keep the
 * installer-detectable process count above 1 during auto-update.
 */
export function killAllRunningJobs(): void {
  for (const [, job] of runningJobs) {
    try {
      job.process.kill('SIGKILL')
    } catch {
      // Best-effort; nothing else to do during shutdown.
    }
  }
  runningJobs.clear()
}