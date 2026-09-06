// Keeps yt-dlp fresh inside the bootstrapped Python runtime.
//
// YouTube changes its player / streaming clients every few weeks and each
// change breaks whichever yt-dlp release is pinned in requirements.txt
// (typical symptom: `ERROR: unable to download video data: HTTP Error 403:
// Forbidden`). Re-pinning requirements.txt would force every user through a
// full runtime re-provision (~700 MB), so instead we upgrade yt-dlp in place
// with pip:
//
//   * at most once a day before any auto-chart run / video download that
//     involves a remote URL, and
//   * immediately (forced) when a download fails with a 403-class error, so
//     the caller can retry with the fixed build.
//
// yt-dlp's `nightly` channel is the project's recommended channel for regular
// users and is published to PyPI as dev releases; the `.dev0` marker in the
// requirement specifier lets pip pick those for yt-dlp only (deps still
// resolve to stable). `[default]` pulls the yt-dlp-ejs challenge-solver
// scripts and `[deno]` a pip-packaged deno binary, which yt-dlp discovers
// automatically in the runtime's Scripts/bin dir. Without a JS runtime yt-dlp
// falls back to a deprecated JS-less extraction path that YouTube keeps
// shutting down.
//
// The pinned yt-dlp in requirements.txt is still what fresh runtimes start
// with; this module only ever moves forward from there.

import { app, BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getRuntimeRoot, isBootstrapTarget } from './runtimeBootstrap'
import type { AutoChartProgressEvent, AutoChartStage } from './types'

/**
 * Preferred install spec: nightly-capable yt-dlp with the EJS solver scripts
 * and a bundled deno runtime.
 */
export const YT_DLP_REQUIREMENT = 'yt-dlp[default,deno]>=2026.7.4.dev0'
/**
 * Fallback when the deno wheel is unavailable for this platform — yt-dlp
 * itself still gets upgraded.
 */
const YT_DLP_REQUIREMENT_NO_DENO = 'yt-dlp[default]>=2026.7.4.dev0'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 60 * 1000
const PIP_TIMEOUT_MS = 10 * 60 * 1000
const VERSION_PROBE_TIMEOUT_MS = 30_000

/**
 * Error text patterns that mean "YouTube rejected yt-dlp's request", i.e. the
 * installed yt-dlp is (probably) stale. Used by callers to decide whether a
 * forced refresh + retry is worth attempting.
 */
const YT_DLP_BLOCKED_PATTERNS = [
  /HTTP Error 403/i,
  /403:? Forbidden/i,
  /unable to download video data/i,
  /Requested format is not available/i,
  /nsig extraction failed|Signature extraction failed/i,
  /Only images are available for download/i
]

export function isYtDlpBlockedError(message: string): boolean {
  return YT_DLP_BLOCKED_PATTERNS.some((pattern) => pattern.test(message))
}

export type PythonInvocation = {
  command: string
  baseArgs: string[]
}

export type YtDlpRefreshResult = {
  /** True when pip actually ran (not skipped by the daily throttle). */
  attempted: boolean
  /** True when pip ran and exited successfully. */
  succeeded: boolean
  /** True when the installed yt-dlp version differs from before the refresh. */
  changed: boolean
  /** yt-dlp version installed after the refresh (or currently, when skipped). */
  version: string | null
  /** yt-dlp version installed before the refresh. */
  previousVersion: string | null
  /** Human-readable reason when the refresh was skipped or failed. */
  note?: string
}

type RefreshState = {
  requirement: string
  lastAttemptAt: string
  lastSuccessAt?: string
  version?: string
  lastError?: string
}

function isOCTAVEManagedRuntimePython(python: PythonInvocation): boolean {
  const runtimeRoot = resolve(getRuntimeRoot())
  const pythonPath = resolve(python.command)
  const pathFromRuntime = relative(runtimeRoot, pythonPath)
  return (
    pathFromRuntime !== '' &&
    pathFromRuntime !== '..' &&
    !pathFromRuntime.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRuntime)
  )
}

function stateFilePath(python?: PythonInvocation): string {
  const dir =
    isBootstrapTarget() || (python && isOCTAVEManagedRuntimePython(python))
      ? getRuntimeRoot()
      : app.getPath('userData')
  return join(dir, '.octave-ytdlp-refresh.json')
}

function readState(python: PythonInvocation): RefreshState | null {
  try {
    return JSON.parse(readFileSync(stateFilePath(python), 'utf-8')) as RefreshState
  } catch {
    return null
  }
}

async function writeState(python: PythonInvocation, state: RefreshState): Promise<void> {
  const path = stateFilePath(python)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.warn(
      `[yt-dlp] failed to persist refresh state: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

type ProgressSink = {
  runId?: string
  /**
   * Stage to tag progress events with. The renderer drops events whose stage
   * ranks below the one it is currently showing, so a forced refresh in the
   * middle of a run should use that run's current stage (e.g. 'download').
   */
  stage?: AutoChartStage
}

function broadcastProgress(sink: ProgressSink, message: string): void {
  if (!sink.runId) return
  const event: AutoChartProgressEvent = {
    runId: sink.runId,
    stage: sink.stage ?? 'bootstrap',
    message
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('strum:progress', event)
  }
}

/**
 * Whether we're allowed to pip-install into this interpreter. Always true for
 * the userData runtime we provision ourselves; in dev only for a
 * workspace-local `.venv` (never a system / `py` launcher interpreter).
 * `OCTAVE_YTDLP_AUTO_REFRESH=0` disables the mechanism entirely.
 */
export function isManagedPython(python: PythonInvocation): boolean {
  if (process.env.OCTAVE_YTDLP_AUTO_REFRESH === '0') return false
  if (isBootstrapTarget()) return true
  if (isOCTAVEManagedRuntimePython(python)) return true
  return /[\\/]\.venv[\\/]/.test(python.command)
}

function probeVersion(python: PythonInvocation): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      python.command,
      [...python.baseArgs, '-c', "import importlib.metadata as m; print(m.version('yt-dlp'))"],
      { timeout: VERSION_PROBE_TIMEOUT_MS, env: { ...process.env, PYTHONUTF8: '1' } },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const version = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
        resolve(version || null)
      }
    )
  })
}

function runPip(
  python: PythonInvocation,
  requirement: string,
  sink: ProgressSink
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    const args = [
      ...python.baseArgs,
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--prefer-binary',
      '--disable-pip-version-check',
      '--no-input',
      '--timeout',
      '30',
      '--retries',
      '2',
      requirement
    ]
    console.log(`[yt-dlp] refreshing: ${python.command} ${args.join(' ')}`)
    const child = spawn(python.command, args, {
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const tail: string[] = []
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, tail: tail.slice(-20).join('\n') })
    }
    const timer = setTimeout(() => {
      console.warn('[yt-dlp] pip refresh timed out; killing.')
      try {
        child.kill()
      } catch {
        /* noop */
      }
      tail.push('pip refresh timed out')
      finish(false)
    }, PIP_TIMEOUT_MS)

    let lastBroadcast = 0
    const onChunk = (chunk: Buffer): void => {
      for (const raw of chunk.toString('utf-8').split(/\r?\n/)) {
        const line = raw.replace(/\r/g, '').trim()
        if (!line) continue
        tail.push(line)
        if (tail.length > 60) tail.shift()
        const now = Date.now()
        if (sink.runId && now - lastBroadcast > 1000) {
          broadcastProgress(sink, `Updating yt-dlp: ${line.slice(0, 160)}`)
          lastBroadcast = now
        }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', (err) => {
      tail.push(err.message)
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

const inflight = new Map<string, Promise<YtDlpRefreshResult>>()

/**
 * Upgrade yt-dlp inside `python` if it hasn't been checked in the last 24h
 * (or unconditionally when `force` is set). Never throws — a failed refresh
 * just leaves the currently installed build in place and reports `succeeded:
 * false`, so callers can proceed with the download attempt regardless.
 */
export async function ensureFreshYtDlp(
  python: PythonInvocation,
  opts: { runId?: string; stage?: AutoChartStage; force?: boolean; reason?: string } = {}
): Promise<YtDlpRefreshResult> {
  const key = `${python.command} ${python.baseArgs.join(' ')}`
  const pending = inflight.get(key)
  if (pending) return pending

  const task = (async (): Promise<YtDlpRefreshResult> => {
    if (!isManagedPython(python)) {
      return {
        attempted: false,
        succeeded: false,
        changed: false,
        version: null,
        previousVersion: null,
        note: 'yt-dlp auto-refresh is only applied to the OCTAVE-managed Python runtime.'
      }
    }
    if (!existsSync(python.command)) {
      return {
        attempted: false,
        succeeded: false,
        changed: false,
        version: null,
        previousVersion: null,
        note: 'Python runtime not found.'
      }
    }

    const state = readState(python)
    const now = Date.now()
    if (!opts.force && state && state.requirement === YT_DLP_REQUIREMENT) {
      const lastSuccess = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN
      const lastAttempt = Date.parse(state.lastAttemptAt)
      if (Number.isFinite(lastSuccess) && now - lastSuccess < CHECK_INTERVAL_MS) {
        return {
          attempted: false,
          succeeded: false,
          changed: false,
          version: state.version ?? null,
          previousVersion: state.version ?? null,
          note: 'yt-dlp was checked for updates recently.'
        }
      }
      if (
        !Number.isFinite(lastSuccess) &&
        Number.isFinite(lastAttempt) &&
        now - lastAttempt < FAILURE_BACKOFF_MS
      ) {
        return {
          attempted: false,
          succeeded: false,
          changed: false,
          version: state.version ?? null,
          previousVersion: state.version ?? null,
          note: `Skipping yt-dlp update check after a recent failure (${state.lastError ?? 'unknown error'}).`
        }
      }
    }

    const previousVersion = await probeVersion(python)
    const sink: ProgressSink = { runId: opts.runId, stage: opts.stage }
    broadcastProgress(
      sink,
      opts.reason ??
        `Checking for yt-dlp updates${previousVersion ? ` (installed: ${previousVersion})` : ''}...`
    )
    console.log(
      `[yt-dlp] refresh start (installed=${previousVersion ?? 'unknown'}, force=${opts.force === true}${opts.reason ? `, reason=${opts.reason}` : ''})`
    )

    let result = await runPip(python, YT_DLP_REQUIREMENT, sink)
    if (!result.ok) {
      console.warn(`[yt-dlp] refresh with deno failed; retrying without deno.\n${result.tail}`)
      result = await runPip(python, YT_DLP_REQUIREMENT_NO_DENO, sink)
    }

    const version = result.ok ? await probeVersion(python) : previousVersion
    const nowIso = new Date().toISOString()
    await writeState(python, {
      requirement: YT_DLP_REQUIREMENT,
      lastAttemptAt: nowIso,
      ...(result.ok ? { lastSuccessAt: nowIso } : { lastSuccessAt: state?.lastSuccessAt }),
      version: version ?? undefined,
      ...(result.ok ? {} : { lastError: result.tail.split('\n').pop() ?? 'pip failed' })
    })

    const changed = result.ok && !!version && version !== previousVersion
    if (result.ok) {
      const summary = changed
        ? `yt-dlp updated ${previousVersion ?? '?'} → ${version}`
        : `yt-dlp ${version ?? 'unknown'} is up to date`
      console.log(`[yt-dlp] ${summary}`)
      broadcastProgress(sink, `${summary}.`)
    } else {
      console.warn(
        `[yt-dlp] refresh failed; keeping installed build ${previousVersion ?? 'unknown'}.\n${result.tail}`
      )
      broadcastProgress(
        sink,
        `Could not update yt-dlp (keeping ${previousVersion ?? 'installed build'}); continuing.`
      )
    }

    return {
      attempted: true,
      succeeded: result.ok,
      changed,
      version,
      previousVersion,
      ...(result.ok ? {} : { note: result.tail.split('\n').slice(-3).join(' | ') })
    }
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, task)
  return task
}
