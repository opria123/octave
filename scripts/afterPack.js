const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

/**
 * afterPack hook: Strip ALL existing code signatures from every Mach-O
 * binary in the app bundle, then re-sign everything from scratch with
 * a consistent ad-hoc identity.
 *
 * This fixes the "different Team IDs" crash on macOS Sequoia (15+).
 * Electron Framework ships with Electron's team ID baked into its signature.
 * codesign --force alone does NOT clear the old team ID. We must first
 * --remove-signature from every binary, then re-sign from innermost out.
 *
 * Combined with mac.identity: null in electron-builder.yml so electron-builder
 * does not re-sign and overwrite our work.
 */
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const entitlements = path.resolve('build', 'entitlements.mac.plist')

  console.log('  • [afterPack] stripping all existing signatures from Mach-O binaries')

  // Step 1: Find EVERY Mach-O binary and remove its signature.
  // This strips Electron's team ID completely.
  try {
    const allFiles = execSync(
      `find "${appPath}" -type f`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim()

    if (allFiles) {
      let stripped = 0
      for (const f of allFiles.split('\n')) {
        try {
          const fileInfo = execSync(`file "${f}"`, { encoding: 'utf-8' })
          if (fileInfo.includes('Mach-O')) {
            execSync(`codesign --remove-signature "${f}"`, { stdio: 'pipe' })
            stripped++
          }
        } catch {
          // Not signable or already unsigned — skip
        }
      }
      console.log(`    stripped signatures from ${stripped} Mach-O binaries`)
    }
  } catch (e) {
    console.warn('    warning during signature stripping:', e.message)
  }

  // Step 2: Re-sign from innermost to outermost.
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')

  if (fs.existsSync(frameworksPath)) {
    // 2a. Sign all dylibs
    try {
      const dylibs = execSync(
        `find "${frameworksPath}" -name "*.dylib" -type f`,
        { encoding: 'utf-8' }
      ).trim()
      if (dylibs) {
        for (const f of dylibs.split('\n')) {
          execSync(`codesign --force --sign - "${f}"`, { stdio: 'pipe' })
        }
        console.log(`    signed ${dylibs.split('\n').length} dylibs`)
      }
    } catch { /* none found */ }

    // 2b. Sign helper apps (directories)
    try {
      const apps = execSync(
        `find "${frameworksPath}" -name "*.app" -type d -maxdepth 2`,
        { encoding: 'utf-8' }
      ).trim()
      if (apps) {
        for (const a of apps.split('\n')) {
          console.log('    sign helper:', path.basename(a))
          execSync(`codesign --force --sign - "${a}"`, { stdio: 'pipe' })
        }
      }
    } catch { /* none found */ }

    // 2c. Sign framework bundles
    const entries = fs.readdirSync(frameworksPath)
    for (const entry of entries) {
      const full = path.join(frameworksPath, entry)
      if (entry.endsWith('.framework') && fs.statSync(full).isDirectory()) {
        console.log('    sign framework:', entry)
        execSync(`codesign --force --sign - "${full}"`, { stdio: 'pipe' })
      }
    }
  }

  // Step 3: Sign the outer .app bundle with entitlements
  console.log('    sign app:', path.basename(appPath))
  const entFlag = fs.existsSync(entitlements)
    ? `--entitlements "${entitlements}"`
    : ''
  execSync(
    `codesign --force --sign - ${entFlag} "${appPath}"`,
    { stdio: 'inherit' }
  )

  // Step 4: Verify
  try {
    execSync(`codesign --verify --deep --strict "${appPath}"`, {
      encoding: 'utf-8'
    })
    console.log('  ✓ codesign verification passed')
  } catch (e) {
    console.warn('  ⚠ verification warning:', e.stdout || e.stderr || e.message)
  }
}
