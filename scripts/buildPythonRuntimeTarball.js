#!/usr/bin/env node
/**
 * Build a pre-built Python runtime tarball for the host platform/arch and
 * write it to ./dist-runtime/python-runtime-<platform>-<arch>-<shortHash>.tar.gz.
 *
 * Mirrors the install logic in src/main/strumIntegration/runtimeBootstrap.ts
 * but with no electron / userData dependency, so it can run in CI.
 *
 * Steps:
 *   1. Download python-build-standalone for host triple
 *   2. Extract into ./dist-runtime/python-runtime/
 *   3. pip install (setuptools, wheel) -> torch CPU -> base reqs -> basic-pitch
 *   4. Write .octave-bootstrap.json state file
 *   5. tar.gz the python-runtime/ dir
 *
 * NOTE: Keep the constants below in sync with runtimeBootstrap.ts.
 */
'use strict'

const { existsSync, createWriteStream, readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { join, resolve } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const PYTHON_BUILD_STANDALONE_TAG = '20250409'
const PYTHON_VERSION = '3.12.10'

const TARGETS = {
  'win32-x64': { triple: 'x86_64-pc-windows-msvc-install_only', exe: 'python/python.exe' },
  'darwin-x64': { triple: 'x86_64-apple-darwin-install_only', exe: 'python/bin/python3' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin-install_only', exe: 'python/bin/python3' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu-install_only', exe: 'python/bin/python3' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu-install_only', exe: 'python/bin/python3' }
}

const PROJECT_ROOT = resolve(__dirname, '..')
const REQUIREMENTS_PATH = join(PROJECT_ROOT, 'resources', 'strum', 'requirements.txt')
const OUT_DIR = join(PROJECT_ROOT, 'dist-runtime')
const RUNTIME_DIR = join(OUT_DIR, 'python-runtime')

function log(msg) { console.log(`[runtime-builder] ${msg}`) }

function platformKey() { return `${process.platform}-${process.arch}` }

function shortHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 12)
}

async function downloadFile(url, dest) {
  log(`GET ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastLogged = 0
  const reader = res.body.getReader()
  const node = new Readable({
    async read() {
      try {
        const { value, done } = await reader.read()
        if (done) { this.push(null); return }
        received += value.byteLength
        if (total > 0 && received - lastLogged > 25_000_000) {
          const pct = Math.round((received / total) * 100)
          log(`  ${pct}% (${(received / 1_000_000).toFixed(1)}/${(total / 1_000_000).toFixed(1)} MB)`)
          lastLogged = received
        }
        this.push(Buffer.from(value))
      } catch (err) { this.destroy(err) }
    }
  })
  await pipeline(node, createWriteStream(dest))
}

function extractTarGz(archive, dest) {
  mkdirSync(dest, { recursive: true })
  // GNU tar (used on GitHub's Windows runners via Git for Windows) treats
  // any arg containing `:` as `host:path` and tries to SSH. Run tar from
  // inside the destination dir with a copy of the archive so neither -f nor
  // -C carries a drive letter.
  const path = require('path')
  const { copyFileSync, unlinkSync } = require('fs')
  const archiveName = '__extract_input.tar.gz'
  const destAbs = path.resolve(dest)
  const stagedArchive = path.join(destAbs, archiveName)
  copyFileSync(archive, stagedArchive)
  try {
    execFileSync('tar', ['-xzf', archiveName], { stdio: 'inherit', cwd: destAbs })
  } finally {
    try { unlinkSync(stagedArchive) } catch { /* ignore */ }
  }
}

function runPython(pythonExe, args) {
  log(`python ${args.join(' ')}`)
  const result = spawnSync(pythonExe, args, {
    stdio: 'inherit',
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUTF8: '1' }
  })
  if (result.status !== 0) throw new Error(`pip failed (exit ${result.status})`)
}

function splitRequirements(text) {
  const lines = text.split(/\r?\n/)
  let basicPitch = null
  const torch = []
  const baseLines = lines.filter((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return true
    const req = t.split('#')[0].trim()
    if (req.startsWith('basic-pitch')) { basicPitch = req; return false }
    if (req.startsWith('torch==') || req.startsWith('torchaudio==')) { torch.push(req); return false }
    return true
  })
  // Match runtimeBootstrap: rewrite tensorflow -> tensorflow-cpu on Linux.
  const rewritten = baseLines.map((line) => {
    if (process.platform !== 'linux') return line
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const req = t.split('#')[0].trim()
    if (req.startsWith('tensorflow==')) return line.replace(/tensorflow==/, 'tensorflow-cpu==')
    return line
  })
  return { basicPitch, torch, base: rewritten.join('\n') + '\n' }
}

async function main() {
  const target = TARGETS[platformKey()]
  if (!target) throw new Error(`No target for ${platformKey()}`)
  if (!existsSync(REQUIREMENTS_PATH)) throw new Error(`requirements.txt not found at ${REQUIREMENTS_PATH}`)

  const hash = shortHash(REQUIREMENTS_PATH)
  const fullHash = createHash('sha256').update(readFileSync(REQUIREMENTS_PATH)).digest('hex')
  const assetName = `python-runtime-${process.platform}-${process.arch}-${hash}.tar.gz`
  const assetPath = join(OUT_DIR, assetName)

  log(`Building runtime for ${platformKey()} (hash=${hash})`)

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(RUNTIME_DIR, { recursive: true })

  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_STANDALONE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${target.triple}.tar.gz`
  const archivePath = join(OUT_DIR, 'cpython.tar.gz')
  await downloadFile(url, archivePath)
  extractTarGz(archivePath, RUNTIME_DIR)
  rmSync(archivePath, { force: true })

  const pythonExe = join(RUNTIME_DIR, target.exe)
  if (!existsSync(pythonExe)) throw new Error(`Expected python at ${pythonExe} after extract`)

  // 1. setuptools + wheel
  runPython(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'setuptools<81', 'wheel'])

  // 2. torch / torchaudio (CPU)
  const split = splitRequirements(readFileSync(REQUIREMENTS_PATH, 'utf-8'))
  if (split.torch.length > 0) {
    runPython(pythonExe, [
      '-m', 'pip', 'install', '--upgrade', '--no-build-isolation',
      '--index-url', 'https://download.pytorch.org/whl/cpu',
      '--extra-index-url', 'https://pypi.org/simple',
      ...split.torch
    ])
  }

  // 3. base requirements
  // Keep build isolation ON (the default) so sdists like dora-search can
  // pull their build deps (e.g. Cython) into a transient env. Use
  // --prefer-binary to favor wheels when available.
  const baseReq = join(OUT_DIR, 'requirements.base.txt')
  writeFileSync(baseReq, split.base)
  runPython(pythonExe, ['-m', 'pip', 'install', '--upgrade', '--prefer-binary', '-r', baseReq])
  rmSync(baseReq, { force: true })

  // 4. basic-pitch (--no-deps)
  if (split.basicPitch) {
    runPython(pythonExe, ['-m', 'pip', 'install', '--upgrade', '--no-deps', '--prefer-binary', split.basicPitch])
  }

  // 5. state file (matches runtimeBootstrap.writeState shape)
  writeFileSync(join(RUNTIME_DIR, '.octave-bootstrap.json'), JSON.stringify({
    pythonVersion: PYTHON_VERSION,
    pythonBuildTag: PYTHON_BUILD_STANDALONE_TAG,
    requirementsHash: fullHash
  }, null, 2))

  // 6. tarball
  log(`Tarballing -> ${assetName}`)
  // Run from OUT_DIR with a relative archive name so no arg contains a
  // drive-letter colon (GNU tar on Windows would treat it as host:path).
  execFileSync('tar', ['-czf', assetName, 'python-runtime'], {
    stdio: 'inherit',
    cwd: OUT_DIR
  })

  log(`DONE: ${assetPath}`)
  // Surface to GitHub Actions via $GITHUB_OUTPUT.
  if (process.env.GITHUB_OUTPUT) {
    require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `asset_path=${assetPath}\nasset_name=${assetName}\nrequirements_hash=${hash}\n`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
