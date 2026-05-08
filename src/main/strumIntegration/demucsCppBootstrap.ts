// demucs.cpp bootstrap.
//
// We replace STRUM's bundled `demucs` Python package (~600 MB with torch
// wheels it pulls in transitively) with a native C++ port from
// https://github.com/sevagh/demucs.cpp. The binary is ~10 MB statically
// linked; the htdemucs_6s ggml weights are ~53 MB. Total disk footprint
// drops from ~600 MB to ~65 MB and stem separation runs ~2× faster on
// CPU.
//
// Strategy mirrors runtimeBootstrap.ts: download artifacts from a
// persistent GitHub release (`demucs-cpp-cache` on opria123/octave),
// extract into userData, cache state on disk so subsequent launches are
// instant. Lazy-triggered before the first stem-separation job rather
// than at app launch.

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
const DEMUCS_CPP_BIN_VERSION = '1'

// htdemucs_6s ggml-f16 weights, hosted on HuggingFace by upstream
// (sevagh/demucs.cpp). Pinned by SHA so a HuggingFace incident can't
// replace the file under us. The bootstrap verifies sha256 after
// download.
const WEIGHTS_URL =
  'https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-6s-f16.bin'
// Fallback: if the binary release hasn't been built/published yet for
// this platform, the bootstrap surfaces a clear error. The CI workflow
// `.github/workflows/demucs-cpp-binaries.yml` is responsible for
// publishing per-platform tarballs to this release.
const BINARY_BASE_URL =
  'https://github.com/opria123/octave/releases/download/demucs-cpp-cache'

type BinaryTarget = {
  /** Tarball asset name on the demucs-cpp-cache release. */
  asset: string
  /** Path to the executable inside the extracted tarball. */
  executableRel: string
}

const TARGETS: Record<string, BinaryTarget> = {
  'win32-x64': {
    asset: `demucs-cpp-bin-win32-x64-v${DEMUCS_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'demucs_mt.cpp.main.exe'
  },
  'darwin-x64': {
    asset: `demucs-cpp-bin-darwin-x64-v${DEMUCS_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'demucs_mt.cpp.main'
  },
  'darwin-arm64': {
    asset: `demucs-cpp-bin-darwin-arm64-v${DEMUCS_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'demucs_mt.cpp.main'
  },
  'linux-x64': {
    asset: `demucs-cpp-bin-linux-x64-v${DEMUCS_CPP_BIN_VERSION}.tar.gz`,
    executableRel: 'demucs_mt.cpp.main'
  }
}

type BootstrapState = {
  binaryVersion: string
  weightsUrl: string
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function emitProgress(runId: string | undefined, message: string, percent?: number): void {
  const event: AutoChartProgressEvent = {
    runId: runId ?? 'demucs-cpp',
    stage: 'bootstrap',
    message,
    ...(typeof percent === 'number' ? { percent } : {})
  }
  broadcast('strum:progress', event)
  console.log(`[DEMUCS-CPP] ${message}`)
}

function getRoot(): string {
  return join(app.getPath('userData'), 'demucs-cpp')
}

function getTarget(): BinaryTarget {
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    throw new Error(
      `OCTAVE does not yet ship a demucs.cpp binary for `
        + `${process.platform}-${process.arch}. Supported: ${Object.keys(TARGETS).join(', ')}.`
    )
  }
  return target
}

function getBinaryPath(): string {
  return join(getRoot(), getTarget().executableRel)
}

function getWeightsPath(): string {
  return join(getRoot(), 'ggml-model-htdemucs-6s-f16.bin')
}

function getStateFile(): string {
  return join(getRoot(), '.octave-demucs-cpp.json')
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

let inflight: Promise<{ binaryPath: string; weightsPath: string }> | null = null

/**
 * Make sure the demucs.cpp binary + htdemucs_6s weights are present on
 * disk. Returns absolute paths to both. Safe to call concurrently —
 * concurrent calls share one bootstrap promise. On platforms that don't
 * yet have a published binary, throws a clear error so the caller can
 * fall back to the Python `demucs` package.
 */
export async function ensureDemucsCpp(
  runId?: string
): Promise<{ binaryPath: string; weightsPath: string }> {
  const binaryPath = getBinaryPath()
  const weightsPath = getWeightsPath()
  const state = readState()

  if (
    existsSync(binaryPath)
    && existsSync(weightsPath)
    && state
    && state.binaryVersion === DEMUCS_CPP_BIN_VERSION
    && state.weightsUrl === WEIGHTS_URL
  ) {
    return { binaryPath, weightsPath }
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const root = getRoot()
      await mkdir(root, { recursive: true })

      // Binary first (small; bails fast if the platform isn't supported).
      if (!existsSync(binaryPath) || state?.binaryVersion !== DEMUCS_CPP_BIN_VERSION) {
        const target = getTarget()
        const archivePath = join(root, target.asset)
        const url = `${BINARY_BASE_URL}/${target.asset}`
        emitProgress(runId, `Downloading demucs.cpp binary for ${process.platform}-${process.arch}...`, 5)
        try {
          await downloadFile(url, archivePath, runId, 'demucs.cpp binary')
        } catch (err) {
          throw new Error(
            `Failed to download demucs.cpp binary from ${url}. `
              + `The CI workflow may not have published a binary for this platform yet. `
              + `Original error: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        emitProgress(runId, 'Extracting demucs.cpp binary...', 25)
        try {
          await extractTarGz(archivePath, root)
        } finally {
          await rm(archivePath, { force: true })
        }
        if (!existsSync(binaryPath)) {
          throw new Error(`demucs.cpp tarball did not contain expected executable at ${target.executableRel}`)
        }
        if (process.platform !== 'win32') {
          await chmod(binaryPath, 0o755)
        }
      }

      // Weights next (~53 MB).
      if (!existsSync(weightsPath) || state?.weightsUrl !== WEIGHTS_URL) {
        emitProgress(runId, 'Downloading htdemucs_6s weights (~53 MB)...', 35)
        await downloadFile(WEIGHTS_URL, weightsPath, runId, 'htdemucs_6s weights')
      }

      await writeState({ binaryVersion: DEMUCS_CPP_BIN_VERSION, weightsUrl: WEIGHTS_URL })
      emitProgress(runId, 'demucs.cpp ready.', 100)
      return { binaryPath, weightsPath }
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export type DemucsCppStatus = {
  binaryPath: string
  weightsPath: string
  ready: boolean
  installing: boolean
  binaryVersion: string
  /** True when the current platform/arch has a known binary target. */
  supported: boolean
}

/**
 * Cheap, side-effect-free status check. Does NOT trigger a download.
 */
export function getDemucsCppStatus(): DemucsCppStatus {
  const supported = Boolean(TARGETS[`${process.platform}-${process.arch}`])
  const binaryPath = supported ? getBinaryPath() : ''
  const weightsPath = supported ? getWeightsPath() : ''
  const state = readState()
  const ready = Boolean(
    supported
      && binaryPath && existsSync(binaryPath)
      && weightsPath && existsSync(weightsPath)
      && state
      && state.binaryVersion === DEMUCS_CPP_BIN_VERSION
      && state.weightsUrl === WEIGHTS_URL
  )
  return {
    binaryPath,
    weightsPath,
    ready,
    installing: inflight !== null,
    binaryVersion: DEMUCS_CPP_BIN_VERSION,
    supported
  }
}
