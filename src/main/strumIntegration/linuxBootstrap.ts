// On Linux we don't ship a bundled Python runtime in the AppImage (a torch
// install would push the package past 3 GB and break electron-builder + fpm).
// Instead, on first launch we provision a venv into the user's data dir
// using the system python3.12 / python3.11 interpreter and install the
// pinned requirements.txt that lives next to strum_worker.py.
//
// Subsequent launches reuse the venv as long as the requirements hash and
// Python version still match.

import { app, BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import type { AutoChartProgressEvent } from './types'

const PYTHON_CHECK_TIMEOUT_MS = 10_000

type SystemPython = {
  command: string
  version: string
}

type BootstrapState = {
  requirementsHash: string
  pythonVersion: string
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

function getVenvDir(): string {
  return join(app.getPath('userData'), 'python-runtime')
}

function getVenvPython(): string {
  return join(getVenvDir(), 'bin', 'python3')
}

function getStateFile(): string {
  return join(getVenvDir(), '.octave-bootstrap.json')
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function checkPython(command: string): Promise<SystemPython | null> {
  return await new Promise<SystemPython | null>((resolve) => {
    execFile(command, ['--version'], { timeout: PYTHON_CHECK_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        resolve(null)
        return
      }
      const text = (stdout || stderr || '').trim()
      const match = text.match(/Python\s+(\d+)\.(\d+)\.(\d+)/)
      if (!match) {
        resolve(null)
        return
      }
      const major = Number(match[1])
      const minor = Number(match[2])
      // torch wheels are only published for 3.10 - 3.12 right now. Match the
      // same range our bundled runtimes (Win/Mac) target.
      if (major !== 3 || minor < 10 || minor > 12) {
        resolve(null)
        return
      }
      resolve({ command, version: `${major}.${minor}.${match[3]}` })
    })
  })
}

async function findSystemPython(): Promise<SystemPython> {
  const candidates = ['python3.12', 'python3.11', 'python3.10', 'python3']
  for (const c of candidates) {
    const found = await checkPython(c)
    if (found) return found
  }
  throw new Error(
    'No suitable Python interpreter found. OCTAVE needs python3.10, 3.11, or 3.12 on PATH '
    + 'to bootstrap its ML runtime on first launch. On Debian/Ubuntu try '
    + '`sudo apt install python3.12 python3.12-venv`.'
  )
}

function readState(): BootstrapState | null {
  try {
    const text = readFileSync(getStateFile(), 'utf-8')
    return JSON.parse(text) as BootstrapState
  } catch {
    return null
  }
}

async function writeState(state: BootstrapState): Promise<void> {
  await writeFile(getStateFile(), JSON.stringify(state, null, 2), 'utf-8')
}

function splitRequirements(requirementsPath: string): {
  basicPitchRequirement: string | null
  torchRequirements: string[]
  baseRequirementsText: string
} {
  const raw = readFileSync(requirementsPath, 'utf-8')
  const lines = raw.split(/\r?\n/)

  let basicPitchRequirement: string | null = null
  const torchRequirements: string[] = []
  const baseLines = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return true
    const requirement = trimmed.split('#')[0].trim()
    if (requirement.startsWith('basic-pitch')) {
      basicPitchRequirement = requirement
      return false
    }
    if (requirement.startsWith('torch==') || requirement.startsWith('torchaudio==')) {
      torchRequirements.push(requirement)
      return false
    }
    return true
  })

  return {
    basicPitchRequirement,
    torchRequirements,
    baseRequirementsText: `${baseLines.join('\n')}\n`
  }
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
      // Throttle broadcasts so we don't flood the renderer with every pip line.
      if (now - lastBroadcast > 1000) {
        const text = chunk.toString('utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop()
        if (text) {
          emitProgress(runId, `${label}: ${text.slice(0, 160)}`)
        }
        lastBroadcast = now
      }
      // Mirror to main process logs so we can debug if a user reports issues.
      process.stdout.write(chunk)
    }

    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${label} failed with exit code ${code}`))
    })
  })
}

async function installRequirements(
  venvPython: string,
  requirementsPath: string,
  runId: string | undefined
): Promise<void> {
  emitProgress(runId, 'Installing build dependencies (setuptools, wheel)...', 7)
  await runStreaming(
    venvPython,
    ['-m', 'pip', 'install', '--upgrade', 'setuptools<81', 'wheel'],
    runId,
    'pip setuptools'
  )

  const { basicPitchRequirement, torchRequirements, baseRequirementsText } = splitRequirements(requirementsPath)

  if (torchRequirements.length > 0) {
    emitProgress(runId, 'Installing torch (CPU build, ~200 MB)...', 9)
    await runStreaming(
      venvPython,
      [
        '-m', 'pip', 'install', '--upgrade', '--no-build-isolation',
        '--index-url', 'https://download.pytorch.org/whl/cpu',
        '--extra-index-url', 'https://pypi.org/simple',
        ...torchRequirements
      ],
      runId,
      'pip torch'
    )
  }

  const tempReqPath = join(getVenvDir(), 'requirements.base.txt')
  await writeFile(tempReqPath, baseRequirementsText, 'utf-8')

  try {
    emitProgress(runId, 'Installing ML/audio dependencies...', 12)
    await runStreaming(
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', '--no-build-isolation', '-r', tempReqPath],
      runId,
      'pip base'
    )

    if (basicPitchRequirement) {
      emitProgress(runId, 'Installing basic-pitch...', 16)
      await runStreaming(
        venvPython,
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
 * Ensure a usable Python interpreter exists for STRUM on packaged Linux.
 * Returns the absolute path to a venv python that has all required packages
 * installed. Safe to call concurrently — concurrent calls share one bootstrap.
 */
export async function ensureLinuxBootstrappedPython(
  requirementsPath: string,
  runId?: string
): Promise<string> {
  const venvPython = getVenvPython()
  const requirementsHash = sha256OfFile(requirementsPath)
  const state = readState()

  if (existsSync(venvPython) && state && state.requirementsHash === requirementsHash) {
    return venvPython
  }

  if (bootstrapInflight) {
    return bootstrapInflight
  }

  bootstrapInflight = (async () => {
    try {
      emitProgress(runId, 'Locating system Python...', 2)
      const sys = await findSystemPython()
      emitProgress(runId, `Using ${sys.command} (Python ${sys.version})`, 3)

      // Wipe any partial/stale venv before reprovisioning.
      const venvDir = getVenvDir()
      await rm(venvDir, { recursive: true, force: true })
      await mkdir(venvDir, { recursive: true })

      emitProgress(runId, 'Creating virtual environment...', 5)
      await runStreaming(sys.command, ['-m', 'venv', venvDir], runId, 'venv')

      if (!existsSync(venvPython)) {
        throw new Error(
          `venv created but ${venvPython} is missing. Install python3.12-venv `
          + '(e.g. `sudo apt install python3.12-venv`) and try again.'
        )
      }

      await installRequirements(venvPython, requirementsPath, runId)

      await writeState({ requirementsHash, pythonVersion: sys.version })
      emitProgress(runId, 'Python runtime ready.', 19)
      return venvPython
    } finally {
      bootstrapInflight = null
    }
  })()

  return bootstrapInflight
}

export function isLinuxBootstrapTarget(): boolean {
  return process.platform === 'linux' && app.isPackaged
}
