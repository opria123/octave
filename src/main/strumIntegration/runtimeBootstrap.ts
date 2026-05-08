// Cross-platform Python runtime bootstrap.
//
// Instead of bundling a Python interpreter + ML packages inside the installer
// (which would push it past 2 GB and force a full reinstall on every patch),
// we provision a self-contained Python interpreter into the user's data dir
// on first launch.
//
// Strategy:
//   1. Download a pinned `python-build-standalone` tarball from GitHub
//      releases (~30 MB compressed, ~150 MB extracted). These distributions
//      are fully relocatable and work on Win/Mac/Linux without system Python.
//   2. Extract with the system `tar` (present on Windows 10+, macOS, Linux).
//   3. pip-install the pinned requirements.txt next to strum_worker.py.
//   4. Cache state so subsequent launches skip everything.
//
// Step 3 of the rollout will replace step 3 above with a download of a
// pre-built site-packages tarball (built on CI), which drops first-launch
// setup from minutes to seconds. This module's public API stays the same.

import { app, BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync, createWriteStream } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { AutoChartProgressEvent } from './types'

// Pinned python-build-standalone release. Bump in lockstep with
// requirements.txt if the wheel set requires a newer Python.
//
// 3.12 chosen because:
//   * torch 2.6 wheels are published for 3.10–3.12
//   * 3.13 lacks several wheels in our stack as of 2026-05
const PYTHON_BUILD_STANDALONE_TAG = '20250409'
const PYTHON_VERSION = '3.12.10'

// Pre-built Python runtime tarballs are uploaded to a persistent GitHub
// release named `runtime-cache` on the OCTAVE repo by
// .github/workflows/python-runtime-tarball.yml. Asset name pattern is
// `python-runtime-<platform>-<arch>-<requirementsShortHash>.tar.gz`.
//
// The hash is the first 12 characters of sha256(requirements.txt), so each
// new requirements.txt change creates new assets without invalidating older
// app builds.
const PREBUILT_RUNTIME_BASE_URL = 'https://github.com/opria123/octave/releases/download/runtime-cache'

type RuntimeTarget = {
  /** python-build-standalone target triple */
  triple: string
  /** Path inside the extracted archive to the python executable */
  executableRel: string
}

const TARGETS: Record<string, RuntimeTarget> = {
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc-install_only',
    executableRel: 'python/python.exe'
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin-install_only',
    executableRel: 'python/bin/python3'
  },
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin-install_only',
    executableRel: 'python/bin/python3'
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu-install_only',
    executableRel: 'python/bin/python3'
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-gnu-install_only',
    executableRel: 'python/bin/python3'
  }
}

type BootstrapState = {
  pythonVersion: string
  pythonBuildTag: string
  requirementsHash: string
  /** 'cuda' or 'cpu'. Switching machines invalidates the prebuilt runtime. */
  accelerator?: string
}

/**
 * Detect whether this machine can run a CUDA-enabled torch wheel. We only
 * advertise CUDA on win/linux x64; Apple Silicon already gets MPS via the
 * default torch wheel.
 */
export function detectAccelerator(): 'cuda' | 'cpu' {
  if (process.platform !== 'win32' && process.platform !== 'linux') return 'cpu'
  if (process.arch !== 'x64') return 'cpu'
  try {
    // nvidia-smi exits 0 when an NVIDIA driver + GPU is present.
    // execFileSync would deadlock on stuck drivers; use sync spawn semantics
    // with a hard timeout via spawnSync.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('child_process') as typeof import('child_process')
    const result = spawnSync('nvidia-smi', ['-L'], { timeout: 4000, encoding: 'utf-8' })
    if (result.status === 0 && /\bGPU\s+\d+:/i.test(result.stdout ?? '')) return 'cuda'
  } catch {
    // nvidia-smi not present — no NVIDIA driver installed.
  }
  return 'cpu'
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function emitProgress(runId: string | undefined, message: string, percent?: number): void {
  const event: AutoChartProgressEvent = {
    runId: runId ?? 'bootstrap',
    stage: 'bootstrap',
    message,
    ...(typeof percent === 'number' ? { percent } : {})
  }
  broadcast('strum:progress', event)
  console.log(`[BOOTSTRAP] ${message}`)
}

function getRuntimeRoot(): string {
  return join(app.getPath('userData'), 'python-runtime')
}

function getRuntimeExecutable(): string {
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    throw new Error(
      `OCTAVE does not yet ship a bootstrappable Python runtime for `
      + `${process.platform}-${process.arch}. Supported: ${Object.keys(TARGETS).join(', ')}.`
    )
  }
  return join(getRuntimeRoot(), target.executableRel)
}

function getStateFile(): string {
  return join(getRuntimeRoot(), '.octave-bootstrap.json')
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readState(): BootstrapState | null {
  try {
    return JSON.parse(readFileSync(getStateFile(), 'utf-8')) as BootstrapState
  } catch {
    return null
  }
}

async function writeState(state: BootstrapState): Promise<void> {
  await writeFile(getStateFile(), JSON.stringify(state, null, 2), 'utf-8')
}

function getDownloadUrl(): string {
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    throw new Error(`No python-build-standalone target for ${process.platform}-${process.arch}.`)
  }
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/`
    + `${PYTHON_BUILD_STANDALONE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${target.triple}.tar.gz`
  )
}

function getPrebuiltTarballUrl(requirementsHash: string): string {
  const shortHash = requirementsHash.slice(0, 12)
  return `${PREBUILT_RUNTIME_BASE_URL}/python-runtime-${process.platform}-${process.arch}-${shortHash}.tar.gz`
}

/**
 * Try the fast path: download a pre-built site-packages tarball from our
 * `runtime-cache` GitHub release and extract it directly into the runtime
 * root. Returns true when the prebuilt tarball was used successfully.
 */
async function tryPrebuiltRuntime(
  runtimeRoot: string,
  requirementsHash: string,
  runId: string | undefined
): Promise<boolean> {
  const url = getPrebuiltTarballUrl(requirementsHash)
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!head.ok) {
      console.log(`[BOOTSTRAP] No prebuilt tarball at ${url} (${head.status}); falling back to pip install.`)
      return false
    }
  } catch (err) {
    console.log(`[BOOTSTRAP] Prebuilt tarball HEAD failed (${err instanceof Error ? err.message : String(err)}); falling back.`)
    return false
  }

  const archivePath = join(runtimeRoot, 'python-runtime-prebuilt.tar.gz')
  emitProgress(runId, 'Downloading pre-built Python runtime (~700 MB)...', 5)
  try {
    await downloadFile(url, archivePath, runId, 'Pre-built runtime')
    emitProgress(runId, 'Extracting pre-built runtime...', 85)
    await extractTarGz(archivePath, runtimeRoot)
  } finally {
    await rm(archivePath, { force: true })
  }

  if (!existsSync(getRuntimeExecutable())) {
    throw new Error('Pre-built runtime tarball did not contain expected python executable.')
  }
  return true
}

async function downloadFile(url: string, destination: string, runId: string | undefined, label: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  let lastEmit = 0

  const body = response.body as ReadableStream<Uint8Array>
  const reader = body.getReader()
  const out = createWriteStream(destination)

  // Manually pump so we can emit progress without pulling in extra deps.
  const nodeStream = new Readable({
    async read() {
      try {
        const { value, done } = await reader.read()
        if (done) {
          this.push(null)
          return
        }
        received += value.byteLength
        const now = Date.now()
        if (total > 0 && now - lastEmit > 250) {
          const pct = Math.min(99, Math.round((received / total) * 100))
          emitProgress(runId, `${label}: ${pct}% (${(received / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB)`)
          lastEmit = now
        }
        this.push(Buffer.from(value))
      } catch (err) {
        this.destroy(err as Error)
      }
    }
  })
  await pipeline(nodeStream, out)
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  // tar is built into Windows 10 1803+, macOS, and Linux. -xzf works
  // identically across all three.
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xzf', archivePath, '-C', destDir], (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function runStreaming(
  command: string,
  args: string[],
  runId: string | undefined,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONUTF8: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let lastBroadcast = 0
    const onChunk = (chunk: Buffer) => {
      const now = Date.now()
      if (now - lastBroadcast > 1000) {
        const text = chunk.toString('utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop()
        if (text) emitProgress(runId, `${label}: ${text.slice(0, 160)}`)
        lastBroadcast = now
      }
      process.stdout.write(chunk)
    }

    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with exit code ${code}`))
    })
  })
}

function splitRequirements(requirementsPath: string, accelerator: 'cuda' | 'cpu'): {
  basicPitchRequirement: string | null
  torchRequirements: string[]
  baseRequirementsText: string
} {
  const raw = readFileSync(requirementsPath, 'utf-8')
  const lines = raw.split(/\r?\n/)

  let basicPitchRequirement: string | null = null
  const torchRequirements: string[] = []
  const baseLines = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const requirement = trimmed.split('#')[0].trim()
    // basic-pitch is installed last with --no-deps so it can't pull in TF.
    if (requirement.startsWith('basic-pitch')) {
      basicPitchRequirement = requirement
      return null
    }
    // torch needs the matching CUDA index URL.
    if (requirement.startsWith('torch==') || requirement.startsWith('torchaudio==')) {
      torchRequirements.push(requirement)
      return null
    }
    // Swap the onnxruntime variant on CUDA hosts so basic-pitch can run
    // its ONNX model on the GPU. Both packages publish the same import
    // name (`onnxruntime`).
    if (accelerator === 'cuda' && /^onnxruntime==/.test(requirement)) {
      return line.replace('onnxruntime==', 'onnxruntime-gpu==')
    }
    return line
  }).filter((line): line is string => line !== null)

  return {
    basicPitchRequirement,
    torchRequirements,
    baseRequirementsText: `${baseLines.join('\n')}\n`
  }
}

async function installRequirements(
  pythonPath: string,
  requirementsPath: string,
  runId: string | undefined,
  accelerator: 'cuda' | 'cpu'
): Promise<void> {
  emitProgress(runId, 'Installing build dependencies (setuptools, wheel)...', 35)
  await runStreaming(
    pythonPath,
    ['-m', 'pip', 'install', '--upgrade', 'setuptools<81', 'wheel'],
    runId,
    'pip setuptools'
  )

  const { basicPitchRequirement, torchRequirements, baseRequirementsText } = splitRequirements(requirementsPath, accelerator)

  if (torchRequirements.length > 0) {
    const isCuda = accelerator === 'cuda'
    const torchIndex = isCuda
      ? 'https://download.pytorch.org/whl/cu124'
      : 'https://download.pytorch.org/whl/cpu'
    emitProgress(
      runId,
      isCuda
        ? 'Installing torch (CUDA 12.4 build, ~2.5 GB)...'
        : 'Installing torch (CPU build, ~200 MB)...',
      45
    )
    await runStreaming(
      pythonPath,
      [
        '-m', 'pip', 'install', '--upgrade', '--no-build-isolation',
        '--index-url', torchIndex,
        '--extra-index-url', 'https://pypi.org/simple',
        ...torchRequirements
      ],
      runId,
      'pip torch'
    )
  }

  const tempReqPath = join(getRuntimeRoot(), 'requirements.base.txt')
  await writeFile(tempReqPath, baseRequirementsText, 'utf-8')

  try {
    emitProgress(runId, 'Installing ML/audio dependencies (~600 MB)...', 60)
    await runStreaming(
      pythonPath,
      ['-m', 'pip', 'install', '--upgrade', '--no-build-isolation', '-r', tempReqPath],
      runId,
      'pip base'
    )

    if (basicPitchRequirement) {
      emitProgress(runId, 'Installing basic-pitch...', 90)
      await runStreaming(
        pythonPath,
        ['-m', 'pip', 'install', '--upgrade', '--no-deps', basicPitchRequirement],
        runId,
        'pip basic-pitch'
      )
    }
  } finally {
    await rm(tempReqPath, { force: true })
  }
}

let bootstrapInflight: Promise<string> | null = null

/**
 * Ensure a usable Python interpreter exists on this machine.
 * Returns the absolute path to the bootstrapped python with all required
 * packages installed. Safe to call concurrently — concurrent calls share one
 * bootstrap promise.
 */
export async function ensureBootstrappedPython(
  requirementsPath: string,
  runId?: string
): Promise<string> {
  const pythonPath = getRuntimeExecutable()
  const requirementsHash = sha256OfFile(requirementsPath)
  const accelerator = detectAccelerator()
  const state = readState()

  if (
    existsSync(pythonPath)
    && state
    && state.requirementsHash === requirementsHash
    && state.pythonBuildTag === PYTHON_BUILD_STANDALONE_TAG
    && state.pythonVersion === PYTHON_VERSION
    && (state.accelerator ?? 'cpu') === accelerator
  ) {
    return pythonPath
  }

  if (bootstrapInflight) return bootstrapInflight

  bootstrapInflight = (async () => {
    try {
      const runtimeRoot = getRuntimeRoot()

      // Wipe any partial/stale runtime before re-provisioning.
      await rm(runtimeRoot, { recursive: true, force: true })
      await mkdir(runtimeRoot, { recursive: true })

      // Fast path: download pre-built tarball if CI has published one for
      // this platform + requirements hash. Drops install time from minutes
      // to ~30 sec. Skipped when an NVIDIA GPU is detected because the
      // prebuilt tarballs ship CPU torch only.
      const usedPrebuilt = accelerator === 'cuda'
        ? false
        : await tryPrebuiltRuntime(runtimeRoot, requirementsHash, runId).catch((err) => {
            console.warn(`[BOOTSTRAP] Prebuilt runtime path failed; falling back to pip install. ${err instanceof Error ? err.message : String(err)}`)
            return false
          })

      if (!usedPrebuilt) {
        const url = getDownloadUrl()
        const archivePath = join(runtimeRoot, 'python-runtime.tar.gz')
        emitProgress(runId, `Downloading Python ${PYTHON_VERSION} runtime...`, 5)
        await downloadFile(url, archivePath, runId, 'Python runtime')

        emitProgress(runId, 'Extracting Python runtime...', 25)
        await extractTarGz(archivePath, runtimeRoot)
        await rm(archivePath, { force: true })

        if (!existsSync(pythonPath)) {
          throw new Error(
            `Python runtime extracted but ${pythonPath} is missing. The downloaded `
            + `archive may be for the wrong platform (${process.platform}-${process.arch}).`
          )
        }

        await installRequirements(pythonPath, requirementsPath, runId, accelerator)
      }

      await writeState({
        pythonVersion: PYTHON_VERSION,
        pythonBuildTag: PYTHON_BUILD_STANDALONE_TAG,
        requirementsHash,
        accelerator
      })
      emitProgress(runId, 'Python runtime ready.', 100)
      return pythonPath
    } finally {
      bootstrapInflight = null
    }
  })()

  return bootstrapInflight
}

/**
 * True when this build path requires the userData runtime (i.e. always, in
 * packaged mode). Kept as a function so future builds could opt out (e.g. if
 * a system Python override is set via env).
 */
export function isBootstrapTarget(): boolean {
  return app.isPackaged
}

export type RuntimeStatus = {
  /** Final python executable path (may not exist yet). */
  pythonPath: string
  /** True when the runtime is fully provisioned for the current requirements. */
  ready: boolean
  /** True when a bootstrap is currently in flight. */
  installing: boolean
  /** Pinned python-build-standalone tag for telemetry. */
  pythonBuildTag: string
  /** Python version this build targets. */
  pythonVersion: string
}

/**
 * Cheap, side-effect-free status check used by the renderer to decide whether
 * to surface the "Set up AI features" banner. Does NOT trigger a bootstrap.
 */
export function getRuntimeStatus(requirementsPath: string): RuntimeStatus {
  const pythonPath = getRuntimeExecutable()
  const status: RuntimeStatus = {
    pythonPath,
    ready: false,
    installing: bootstrapInflight !== null,
    pythonBuildTag: PYTHON_BUILD_STANDALONE_TAG,
    pythonVersion: PYTHON_VERSION
  }
  if (!existsSync(pythonPath)) return status
  if (!existsSync(requirementsPath)) return status
  const state = readState()
  if (!state) return status
  const requirementsHash = sha256OfFile(requirementsPath)
  const accelerator = detectAccelerator()
  status.ready = (
    state.requirementsHash === requirementsHash
    && state.pythonBuildTag === PYTHON_BUILD_STANDALONE_TAG
    && state.pythonVersion === PYTHON_VERSION
    && (state.accelerator ?? 'cpu') === accelerator
  )
  return status
}
