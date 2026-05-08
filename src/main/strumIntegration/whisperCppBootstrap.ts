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
import { detectAccelerator } from './runtimeBootstrap'

// Bump together with the binary release version. Each bump invalidates
// the on-disk cache so users get the new binary on next launch.
// v2: added per-variant (cuda/cpu) assets so CUDA hosts get cuBLAS-
//     accelerated whisper-cli on Windows + Linux.
const WHISPER_CPP_BIN_VERSION = '2'

// Build variants. CUDA hosts on Windows/Linux x64 prefer the cuBLAS-
// linked tarball (~+150 MB for cuBLAS DLLs) for ~5–10× faster
// transcription. Everything else falls back to the CPU build.
type BinaryVariant = 'cuda' | 'cpu'

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

/**
 * Platforms+arches for which we publish a CUDA-accelerated build.
 * Linux is intentionally excluded: ggml-cuda's template-instance .cu files
 * each peak ~4-5 GB during nvcc PTX generation, and the GitHub-hosted Linux
 * runner OOM-kills the build even at low parallelism. Linux NVIDIA users
 * still get GPU acceleration via Python demucs + onnxruntime-gpu; only
 * whisper transcription falls back to the CPU whisper.cpp binary.
 */
const CUDA_SUPPORTED = new Set<string>(['win32-x64'])

function makeAsset(platform: string, arch: string, variant: BinaryVariant): string {
  return `whisper-cpp-bin-${platform}-${arch}-${variant}-v${WHISPER_CPP_BIN_VERSION}.tar.gz`
}

function getTargetForVariant(platform: string, arch: string, variant: BinaryVariant): BinaryTarget | null {
  const key = `${platform}-${arch}`
  const exe = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  const supported: Record<string, true> = {
    'win32-x64': true,
    'darwin-x64': true,
    'darwin-arm64': true,
    'linux-x64': true
  }
  if (!supported[key]) return null
  if (variant === 'cuda' && !CUDA_SUPPORTED.has(key)) return null
  return { asset: makeAsset(platform, arch, variant), executableRel: exe }
}

function resolveVariant(): BinaryVariant {
  const key = `${process.platform}-${process.arch}`
  if (!CUDA_SUPPORTED.has(key)) return 'cpu'
  return detectAccelerator() === 'cuda' ? 'cuda' : 'cpu'
}

type BootstrapState = {
  binaryVersion: string
  binaryVariant: BinaryVariant
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

function getTarget(variant: BinaryVariant): BinaryTarget {
  const target = getTargetForVariant(process.platform, process.arch, variant)
  if (!target) {
    throw new Error(
      `OCTAVE does not yet ship a whisper.cpp binary for `
        + `${process.platform}-${process.arch} (${variant}).`
    )
  }
  return target
}

function getBinaryPath(variant: BinaryVariant): string {
  return join(getRoot(), getTarget(variant).executableRel)
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
  const variant = resolveVariant()
  const binaryPath = getBinaryPath(variant)
  const modelPath = getModelPath()
  const state = readState()

  if (
    existsSync(binaryPath)
    && existsSync(modelPath)
    && state
    && state.binaryVersion === WHISPER_CPP_BIN_VERSION
    && state.binaryVariant === variant
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
      if (
        !existsSync(binaryPath)
        || state?.binaryVersion !== WHISPER_CPP_BIN_VERSION
        || state?.binaryVariant !== variant
      ) {
        const target = getTarget(variant)
        const archivePath = join(root, target.asset)
        const url = `${BINARY_BASE_URL}/${target.asset}`
        emitProgress(
          runId,
          `Downloading whisper.cpp ${variant.toUpperCase()} binary for ${process.platform}-${process.arch}...`,
          2
        )
        try {
          await downloadFile(url, archivePath, runId, `whisper.cpp ${variant} binary`)
        } catch (err) {
          // CUDA build missing? Fall back to CPU rather than failing the
          // whole vocals pipeline. Common on first rollout where only the
          // CPU asset has been published.
          if (variant === 'cuda') {
            console.warn(
              `[WHISPER-CPP] CUDA binary unavailable (${err instanceof Error ? err.message : String(err)}); falling back to CPU build.`
            )
            const cpuTarget = getTarget('cpu')
            const cpuUrl = `${BINARY_BASE_URL}/${cpuTarget.asset}`
            const cpuArchive = join(root, cpuTarget.asset)
            await downloadFile(cpuUrl, cpuArchive, runId, 'whisper.cpp cpu binary')
            emitProgress(runId, 'Extracting whisper.cpp binary...', 5)
            try {
              await extractTarGz(cpuArchive, root)
            } finally {
              await rm(cpuArchive, { force: true })
            }
            const cpuBinPath = join(root, cpuTarget.executableRel)
            if (!existsSync(cpuBinPath)) {
              throw new Error(`whisper.cpp tarball did not contain expected executable at ${cpuTarget.executableRel}`)
            }
            if (process.platform !== 'win32') {
              await chmod(cpuBinPath, 0o755)
            }
            // Model still needs downloading below; finish writing the
            // CPU-variant state at the end.
            if (!existsSync(modelPath) || state?.modelUrl !== MODEL_URL) {
              emitProgress(runId, 'Downloading ggml-large-v3-q5_0 model (~547 MB, one-time)...', 10)
              await downloadFile(MODEL_URL, modelPath, runId, 'whisper large-v3 model')
            }
            await writeState({ binaryVersion: WHISPER_CPP_BIN_VERSION, binaryVariant: 'cpu', modelUrl: MODEL_URL })
            emitProgress(runId, 'whisper.cpp ready (CPU fallback).', 100)
            return { binaryPath: cpuBinPath, modelPath }
          }
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

      await writeState({ binaryVersion: WHISPER_CPP_BIN_VERSION, binaryVariant: variant, modelUrl: MODEL_URL })
      emitProgress(runId, `whisper.cpp ready (${variant.toUpperCase()}).`, 100)
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
  const variant = resolveVariant()
  const supported = getTargetForVariant(process.platform, process.arch, variant) !== null
    || getTargetForVariant(process.platform, process.arch, 'cpu') !== null
  const binaryPath = supported ? getBinaryPath(variant) : ''
  const modelPath = supported ? getModelPath() : ''
  const state = readState()
  const ready = Boolean(
    supported
      && binaryPath && existsSync(binaryPath)
      && modelPath && existsSync(modelPath)
      && state
      && state.binaryVersion === WHISPER_CPP_BIN_VERSION
      && state.binaryVariant === variant
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
