const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

/**
 * afterPack hook: re-sign all INNER components of the .app bundle with
 * ad-hoc identity BEFORE electron-builder's own signing step runs.
 *
 * This fixes the "different Team IDs" crash on macOS Sequoia (15+).
 * The Electron Framework ships with Electron's team ID signature, but
 * electron-builder only ad-hoc signs the main binary. By pre-signing
 * all inner components with ad-hoc identity here, electron-builder's
 * subsequent signing of the outer app results in consistent (empty)
 * team IDs throughout the bundle.
 *
 * We intentionally do NOT sign the outer .app — electron-builder handles that.
 */
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')

  if (!fs.existsSync(frameworksPath)) {
    console.log('  • no Frameworks directory found, skipping re-sign')
    return
  }

  console.log('  • re-signing inner components with ad-hoc identity')

  // Find and sign all Mach-O binaries and bundles inside Frameworks.
  // Use find to locate every code-signable item, sign innermost first.
  try {
    // 1. Sign all plain executable/dylib files (innermost binaries)
    const files = execSync(
      `find "${frameworksPath}" \\( -name "*.dylib" -o -name "*.so" \\) -type f`,
      { encoding: 'utf-8' }
    ).trim()
    if (files) {
      for (const f of files.split('\n')) {
        console.log('    sign file:', path.basename(f))
        execSync(`codesign --force --sign - "${f}"`, { stdio: 'inherit' })
      }
    }
  } catch { /* no dylibs found */ }

  // 2. Sign all .app helper bundles inside Frameworks (these are directories)
  try {
    const apps = execSync(
      `find "${frameworksPath}" -name "*.app" -type d -maxdepth 2`,
      { encoding: 'utf-8' }
    ).trim()
    if (apps) {
      for (const a of apps.split('\n')) {
        console.log('    sign helper app:', path.basename(a))
        execSync(`codesign --force --sign - "${a}"`, { stdio: 'inherit' })
      }
    }
  } catch { /* no helper apps */ }

  // 3. Sign all .framework bundles (these contain the Electron Framework)
  const entries = fs.readdirSync(frameworksPath)
  for (const entry of entries) {
    const full = path.join(frameworksPath, entry)
    if (entry.endsWith('.framework') && fs.statSync(full).isDirectory()) {
      console.log('    sign framework:', entry)
      execSync(`codesign --force --sign - "${full}"`, { stdio: 'inherit' })
    }
  }

  console.log('  ✓ inner components re-signed (electron-builder will sign outer app)')
}
