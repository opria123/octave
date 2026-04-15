const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

/**
 * afterSign hook: re-sign the entire .app bundle with a consistent ad-hoc
 * identity AFTER electron-builder's own signing step. This fixes the
 * "different Team IDs" crash on macOS Sequoia (15+) where the main binary
 * gets ad-hoc signed but Electron Framework retains its original Team ID.
 *
 * We sign innermost components first, then the outer app bundle, which is
 * the Apple-recommended approach (--deep is unreliable for nested bundles).
 */
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
  const entitlements = path.resolve('build', 'entitlements.mac.plist')

  console.log('  • re-signing macOS app bundle (ad-hoc, component-by-component)')

  // 1. Sign all .dylib files
  const signGlob = (dir, pattern) => {
    try {
      const result = execSync(`find "${dir}" -name "${pattern}" -type f`, {
        encoding: 'utf-8'
      }).trim()
      if (!result) return
      for (const file of result.split('\n')) {
        execSync(`codesign --force -s - "${file}"`, { stdio: 'inherit' })
      }
    } catch {
      // No matches — ok
    }
  }

  signGlob(frameworksPath, '*.dylib')

  // 2. Sign each .framework bundle (innermost first)
  if (fs.existsSync(frameworksPath)) {
    const entries = fs.readdirSync(frameworksPath)
    for (const entry of entries) {
      const full = path.join(frameworksPath, entry)
      if (entry.endsWith('.framework') && fs.statSync(full).isDirectory()) {
        console.log('    signing framework:', entry)
        execSync(`codesign --force -s - "${full}"`, { stdio: 'inherit' })
      }
    }
  }

  // 3. Sign all helper apps inside Frameworks
  signGlob(frameworksPath, '*.app')

  // 4. Sign the outer .app bundle with entitlements
  console.log('    signing app bundle:', appPath)
  if (fs.existsSync(entitlements)) {
    execSync(
      `codesign --force -s - --entitlements "${entitlements}" "${appPath}"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`codesign --force -s - "${appPath}"`, { stdio: 'inherit' })
  }

  // 5. Verify
  try {
    execSync(`codesign --verify --deep --strict "${appPath}"`, {
      stdio: 'inherit'
    })
    console.log('  ✓ codesign verification passed')
  } catch (e) {
    console.warn('  ⚠ codesign verification failed (may still work):', e.message)
  }
}
