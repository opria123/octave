// Try to download a pre-built bundled Python runtime from a GitHub Release
// produced by .github/workflows/python-runtime.yml.
//
// Behavior:
//   - If the runtime is already present and metadata matches, exits silently.
//   - If a matching release asset exists, downloads + extracts it.
//   - If no asset is available (404, no network, etc.), exits 0 so that
//     prepareBundledPython.js can fall back to building from scratch.
//
// Env:
//   GITHUB_REPOSITORY  - "owner/repo" (auto-set in GitHub Actions). Falls back
//                        to opria123/octave so local invocations work too.
//   GITHUB_TOKEN       - optional; bumps the GitHub API rate limit.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')

const { getReleaseTag, getAssetName } = require('./bundledPythonHash')

const projectRoot = path.resolve(__dirname, '..')
const pythonResourcesRoot = path.join(projectRoot, 'resources', 'python')

const repository = process.env.GITHUB_REPOSITORY || 'opria123/octave'
const token = process.env.GITHUB_TOKEN || ''

function getTargetKey() {
  return `${process.platform}-${process.arch}`
}

function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}

function targetDir() {
  return path.join(pythonResourcesRoot, getTargetKey())
}

function metadataPath() {
  return path.join(targetDir(), 'metadata.json')
}

function isAlreadyPresent() {
  if (!exists(metadataPath())) return false
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath(), 'utf-8'))
    return exists(path.join(targetDir(), 'python', meta.executable))
  } catch {
    return false
  }
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'octave-bundled-python-downloader',
      ...options.headers
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const req = https.request(url, { method: 'GET', headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsRequest(res.headers.location, options))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'octave-bundled-python-downloader',
      Accept: 'application/octet-stream'
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const file = fs.createWriteStream(destPath)
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        fs.unlinkSync(destPath)
        downloadToFile(res.headers.location, destPath).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlinkSync(destPath)
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    })
    req.on('error', reject)
    req.end()
  })
}

async function findAssetParts(tag, assetName) {
  const apiUrl = `https://api.github.com/repos/${repository}/releases/tags/${tag}`
  const res = await httpsRequest(apiUrl, { headers: { Accept: 'application/vnd.github+json' } })
  if (res.statusCode === 404) return []
  if (res.statusCode !== 200) {
    throw new Error(`GitHub API returned ${res.statusCode} for ${apiUrl}`)
  }
  const release = JSON.parse(res.body.toString('utf-8'))
  const partPrefix = `${assetName}.part.`
  const parts = (release.assets || [])
    .filter((a) => a.name.startsWith(partPrefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ name: a.name, url: a.url }))
  return parts
}

async function main() {
  if (isAlreadyPresent()) {
    console.log(`  • bundled Python runtime already present for ${getTargetKey()}`)
    return
  }

  const tag = getReleaseTag()
  const assetName = getAssetName(process.platform, process.arch)
  console.log(`  • looking up pre-built runtime  tag=${tag} asset=${assetName}`)

  let parts
  try {
    parts = await findAssetParts(tag, assetName)
  } catch (err) {
    console.log(`  • lookup failed (${err.message}); will fall back to local build`)
    return
  }

  if (!parts || parts.length === 0) {
    console.log(`  • no pre-built runtime published for this requirements hash; will build locally`)
    return
  }

  fs.mkdirSync(targetDir(), { recursive: true })
  const tarballPath = path.join(targetDir(), assetName)
  const partPaths = parts.map((p) => path.join(targetDir(), p.name))

  try {
    console.log(`  • downloading ${parts.length} part(s) of pre-built runtime...`)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      console.log(`    - [${i + 1}/${parts.length}] ${p.name}`)
      await downloadToFile(p.url, path.join(targetDir(), p.name))
    }

    console.log(`  • reassembling tarball...`)
    const out = fs.createWriteStream(tarballPath)
    for (const partPath of partPaths) {
      const data = fs.readFileSync(partPath)
      out.write(data)
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()))
    })
    for (const partPath of partPaths) {
      try { fs.unlinkSync(partPath) } catch { /* noop */ }
    }

    console.log(`  • extracting...`)
    execFileSync('tar', ['-xzf', tarballPath, '-C', targetDir()], { stdio: 'inherit' })
    fs.unlinkSync(tarballPath)

    if (!isAlreadyPresent()) {
      throw new Error('extracted bundle is missing metadata.json or python executable')
    }
    console.log(`  ✓ bundled Python runtime restored from release ${tag}`)
  } catch (err) {
    console.warn(`  ! pre-built download failed: ${err.message}`)
    console.warn(`  • will fall back to local build`)
    try { fs.rmSync(targetDir(), { recursive: true, force: true }) } catch { /* noop */ }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`bundled Python download error: ${err.message}`)
    // Don't fail the build — let the next step build from scratch.
    process.exit(0)
  })
}

module.exports = { main }
