// Shared helper: compute a deterministic short hash that identifies a unique
// bundled Python runtime. Used by both the runtime builder workflow (to tag
// the release) and the download script (to look it up).
//
// Hash inputs:
//   - resources/strum/requirements.txt
//   - scripts/prepareBundledPython.js (the builder itself, since changes to it
//     can change the layout of the produced runtime)

const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')

const HASH_INPUT_FILES = [
  path.join(projectRoot, 'resources', 'strum', 'requirements.txt'),
  path.join(projectRoot, 'scripts', 'prepareBundledPython.js')
]

function computeBundledPythonHash() {
  const hash = createHash('sha256')
  for (const file of HASH_INPUT_FILES) {
    hash.update(path.basename(file))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

function getReleaseTag() {
  return `python-runtime-${computeBundledPythonHash()}`
}

function getAssetName(platform, arch) {
  return `bundled-python-${platform}-${arch}.tar.gz`
}

module.exports = {
  computeBundledPythonHash,
  getReleaseTag,
  getAssetName
}

if (require.main === module) {
  // CLI: print just the hash on stdout for shell consumption.
  const arg = process.argv[2]
  if (arg === '--tag') {
    process.stdout.write(getReleaseTag())
  } else if (arg === '--asset') {
    process.stdout.write(getAssetName(process.argv[3], process.argv[4]))
  } else {
    process.stdout.write(computeBundledPythonHash())
  }
}
