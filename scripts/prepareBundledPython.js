const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const resourcesRoot = path.join(projectRoot, 'resources')
const pythonResourcesRoot = path.join(resourcesRoot, 'python')
const strumRequirementsPath = path.join(resourcesRoot, 'strum', 'requirements.txt')

function getTargetKey() {
  return `${process.platform}-${process.arch}`
}

function getTargetRuntimeDir() {
  return path.join(pythonResourcesRoot, getTargetKey(), 'python')
}

function getMetadataPath() {
  return path.join(pythonResourcesRoot, getTargetKey(), 'metadata.json')
}

function exists(targetPath) {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function removeDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true })
}

function mkdirp(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true })
}

function copyDirectory(sourceDir, destinationDir) {
  mkdirp(destinationDir)
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    if (entry.name === 'test' || entry.name === 'tests') continue
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(sourcePath)
      try {
        fs.symlinkSync(linkTarget, destinationPath)
      } catch {
        const realPath = fs.realpathSync(sourcePath)
        const stat = fs.statSync(realPath)
        if (stat.isDirectory()) {
          copyDirectory(realPath, destinationPath)
        } else {
          fs.copyFileSync(realPath, destinationPath)
        }
      }
    } else {
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

function findBuildPythonCommand() {
  const candidates = []
  const configured = process.env.OCTAVE_BUNDLED_PYTHON || process.env.OCTAVE_STRUM_PYTHON
  if (configured) {
    candidates.push({ command: configured, args: [] })
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'] })
  }
  candidates.push({ command: 'python3', args: [] })
  candidates.push({ command: 'python', args: [] })

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, '--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(
    'Python 3.11+ is required on the build machine to bundle the STRUM runtime. '
    + 'Set OCTAVE_BUNDLED_PYTHON to point at the interpreter to copy.'
  )
}

function runPythonJson(command, args) {
  const output = execFileSync(command.command, [...command.args, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8'
  })
  return JSON.parse(output)
}

function getPythonInfo(command) {
  // NOTE: must be a single semicolon-separated line — dict literals cannot span
  // statements when using `python -c "..."` with `;` joining.
  const script = 'import json, site, sys, sysconfig; '
    + 'data = {'
    + '"version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", '
    + '"major_minor": f"{sys.version_info.major}.{sys.version_info.minor}", '
    + '"base_prefix": sys.base_prefix, '
    + '"executable": sys.executable, '
    + '"purelib": sysconfig.get_path("purelib"), '
    + '"platlib": sysconfig.get_path("platlib"), '
    + '"sitepackages": site.getsitepackages()'
    + '}; '
    + 'print(json.dumps(data))'
  return runPythonJson(command, ['-c', script])
}

function ensureMinimumVersion(version) {
  const [major, minor] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 11)) {
    throw new Error(`Bundled STRUM runtime requires Python 3.11+, got ${version}`)
  }
}

function relativeSitePackages(majorMinor) {
  if (process.platform === 'win32') {
    return path.join('Lib', 'site-packages')
  }
  return path.join('lib', `python${majorMinor}`, 'site-packages')
}

function relativeExecutable() {
  if (process.platform === 'win32') {
    return 'python.exe'
  }
  return path.join('bin', 'python3')
}

function writeMetadata(info, requirementsHash) {
  const metadata = {
    version: info.version,
    majorMinor: info.major_minor,
    executable: relativeExecutable(),
    sitePackages: relativeSitePackages(info.major_minor),
    requirementsHash,
    target: getTargetKey()
  }
  fs.writeFileSync(getMetadataPath(), JSON.stringify(metadata, null, 2) + '\n', 'utf-8')
  return metadata
}

function loadExistingMetadata() {
  const metadataPath = getMetadataPath()
  if (!exists(metadataPath)) return null
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
  } catch {
    return null
  }
}

function ensureBundleFresh(info, requirementsHash) {
  const existing = loadExistingMetadata()
  const targetRuntimeDir = getTargetRuntimeDir()
  if (!existing) return false
  if (!exists(path.join(targetRuntimeDir, existing.executable))) return false
  if (existing.version !== info.version) return false
  if (existing.requirementsHash !== requirementsHash) return false
  return true
}

function installRequirements(command, sitePackagesDir) {
  mkdirp(sitePackagesDir)
  execFileSync(command.command, [
    ...command.args,
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--target',
    sitePackagesDir,
    '-r',
    strumRequirementsPath
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1'
    }
  })
}

function prepareBundledPython() {
  const command = findBuildPythonCommand()
  const info = getPythonInfo(command)
  ensureMinimumVersion(info.version)

  const requirementsHash = sha256File(strumRequirementsPath)
  if (ensureBundleFresh(info, requirementsHash)) {
    console.log(`  • bundled Python runtime already prepared for ${getTargetKey()}`)
    return
  }

  const targetRuntimeDir = getTargetRuntimeDir()
  console.log(`  • preparing bundled Python runtime for ${getTargetKey()} from ${info.base_prefix}`)

  removeDir(targetRuntimeDir)
  mkdirp(path.dirname(targetRuntimeDir))
  copyDirectory(info.base_prefix, targetRuntimeDir)

  const sitePackagesDir = path.join(targetRuntimeDir, relativeSitePackages(info.major_minor))
  installRequirements(command, sitePackagesDir)
  writeMetadata(info, requirementsHash)

  console.log(`  ✓ bundled Python runtime ready at ${targetRuntimeDir}`)
}

if (require.main === module) {
  prepareBundledPython()
}

module.exports = {
  prepareBundledPython
}