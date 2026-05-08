// whisper.cpp bootstrap.
//
// We replace STRUM's bundled `openai-whisper` package (~2 GB once its
// torch + CUDA wheels are pulled in transitively, plus tiktoken/numba)
// with a native C++ port from https://github.com/ggerganov/whisper.cpp.
// The binary is ~5 MB; the ggml-large-v3 q5_0 model is ~547 MB. Total
// disk footprint drops dramatically vs the Python package, transcription
// is faster on CPU, and we avoid bundling tiktoken's tokenizer cache.
//
// Strategy mirrors demucsCppBootstrap.ts: download artifacts from a
// persistent GitHub release (`whisper-cpp-cache` on opria123/octave),
// extract into userData, cache state on disk so subsequent launches are
// instant. Lazy-triggered before the first vocals job rather than at app
// launch — the model alone is half a gig, no point downloading it for
// users who never chart vocals.

import { app, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync, createWriteStream } from 'fs'
import { mkdir, rm, writeFile, chmod } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { AutoChartProgressEvent } from './types'

// Bump together with the binary release version. Each bump invalidates
// the on-disk cache so users get the new binary on next launch.
const WHISPER_CPP_BIN_VERSION = '1'

// large-v3 q5_0 quantised model. User constraint: must be large-v3 (not
// medium/small) for transcription quality; q5_0 keeps the disk footprint
// reasonable (~547 MB vs ~3 GB for fp16).
const MODEL_FILENAME = 'ggml-large-v3-q5_0.bin'
const MODEL_URL =
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILENAME}`

// Per-platform binary tarballs are published to this persistent release
// by .github/workflows/whisper-cpp-binaries.yml.
const BINARY_BASE_URL =
  'https://github.com/opria123/octave/releases/download/whisper-cpp-cache'

type BinaryTarget = {
  /** Tarball asset name on the whisper-cpp-cache release. */
  asset: string
  /** Path to the executable inside the extracted tarball. */
  executableRel: string
}

const TARGETS: Record<string, BinaryTarget> = {
  'win32-x64': {
    asset: `whisper-cpp-bin-win32-x64-v${WHISPER_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'whisper-cli.exe'
  },
  'darwin-x64': {
    asset: `whisper-cpp-bin-darwin-x64-v${WHISPER_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'whisper-cli'
  },
  'darwin-arm64': {
    asset: `whisper-cpp-bin-darwin-arm64-v${WHISPER_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'whisper-cli'
  },
  'linux-x64': {
    asset: `whisper-cpp-bin-linux-x64-v${WHISPER_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'whisper-cli'
  }
}

type BootstrapState = {
  binaryVersion: string
  modelUrl: string
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function emitProgress(runId: string | undefined, message: string, percent?: number): void {
  const event: AutoChartProgressEvent = {
    runId: runId ?? 'whisper-cpp',
    stage: 'bootstrap',
    message,
    ...(typeof percent === 'number' ? { percent } : {})
  }
  broadcast('strum:progress', event)
  console.log(`[WHISPER-CPP] ${message}`)
}

function getRoot(): string {
  return join(app.getPath('userData'), 'whisper-cpp')
}

function getTarget(): BinaryTarget {
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    throw new Error(
      `OCTAVE does not yet ship a whisper.cpp binary for `
        + `${process.platform}-${process.arch}. Supported: ${Object.keys(TARGETS).join(', ')}.`
    )
  }
  return target
}

function getBinaryPath(): string {
  return join(getRoot(), getTarget().executableRel)
}

function getModelPath(): string {
  return join(getRoot(), MODEL_FILENAME)
}

function getStateFile(): string {
  return join(getRoot(), '.octave-whisper-cpp.json')
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

async function downloadFile(
  url: string,
  destination: string,
  runId: string | undefined,
  label: string
): Promise<void> {
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
          emitProgress(
            runId,
            `${label}: ${pct}% (${(received / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB)`
          )
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
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xzf', archivePath, '-C', destDir], (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

let inflight: Promise<{ binaryPath: string; modelPath: string }> | null = null

/**
 * Make sure the whisper.cpp binary + ggml-large-v3-q5_0 model are
 * present on disk. Returns absolute paths to both. Safe to call
 * concurrently — concurrent calls share one bootstrap promise. On
 * platforms that don't yet have a published binary, throws a clear
 * error so the caller can fall back to the Python `whisper` package
 * (if installed in dev environments).
 */
export async function ensureWhisperCpp(
  runId?: string
): Promise<{ binaryPath: string; modelPath: string }> {
  const binaryPath = getBinaryPath()
  const modelPath = getModelPath()
  const state = readState()

  if (
    existsSync(binaryPath)
    && existsSync(modelPath)
    && state
    && state.binaryVersion === WHISPER_CPP_BIN_VERSION
    && state.modelUrl === MODEL_URL
  ) {
    return { binaryPath, modelPath }
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const root = getRoot()
      await mkdir(root, { recursive: true })

      // Binary first (small; bails fast if the platform isn't supported).
      if (!existsSync(binaryPath) || state?.binaryVersion !== WHISPER_CPP_BIN_VERSION) {
        const target = getTarget()
        const archivePath = join(root, target.asset)
        const url = `${BINARY_BASE_URL}/${target.asset}`
        emitProgress(runId, `Downloading whisper.cpp binary for ${process.platform}-${process.arch}...`, 2)
        try {
          await downloadFile(url, archivePath, runId, 'whisper.cpp binary')
        } catch (err) {
          throw new Error(
            `Failed to download whisper.cpp binary from ${url}. `
              + `The CI workflow may not have published a binary for this platform yet. `
              + `Original error: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        emitProgress(runId, 'Extracting whisper.cpp binary...', 5)
        try {
          await extractTarGz(archivePath, root)
        } finally {
          await rm(archivePath, { force: true })
        }
        if (!existsSync(binaryPath)) {
          throw new Error(`whisper.cpp tarball did not contain expected executable at ${target.executableRel}`)
        }
        if (process.platform !== 'win32') {
          await chmod(binaryPath, 0o755)
        }
      }

      // Model next (~547 MB — the slow part).
      if (!existsSync(modelPath) || state?.modelUrl !== MODEL_URL) {
        emitProgress(runId, 'Downloading ggml-large-v3-q5_0 model (~547 MB, one-time)...', 10)
        await downloadFile(MODEL_URL, modelPath, runId, 'whisper large-v3 model')
      }

      await writeState({ binaryVersion: WHISPER_CPP_BIN_VERSION, modelUrl: MODEL_URL })
      emitProgress(runId, 'whisper.cpp ready.', 100)
      return { binaryPath, modelPath }
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export type WhisperCppStatus = {
  binaryPath: string
  modelPath: string
  ready: boolean
  installing: boolean
  binaryVersion: string
  /** True when the current platform/arch has a known binary target. */
  supported: boolean
}

/**
 * Cheap, side-effect-free status check. Does NOT trigger a download.
 */
export function getWhisperCppStatus(): WhisperCppStatus {
  const supported = Boolean(TARGETS[`${process.platform}-${process.arch}`])
  const binaryPath = supported ? getBinaryPath() : ''
  const modelPath = supported ? getModelPath() : ''
  const state = readState()
  const ready = Boolean(
    supported
      && binaryPath && existsSync(binaryPath)
      && modelPath && existsSync(modelPath)
      && state
      && state.binaryVersion === WHISPER_CPP_BIN_VERSION
      && state.modelUrl === MODEL_URL
  )
  return {
    binaryPath,
    modelPath,
    ready,
    installing: inflight !== null,
    binaryVersion: WHISPER_CPP_BIN_VERSION,
    supported
  }
}
