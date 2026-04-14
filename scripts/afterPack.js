const { execSync } = require('child_process')
const path = require('path')

/**
 * After electron-builder packs the app, re-sign the entire .app bundle
 * with a consistent ad-hoc identity. This fixes the "different Team IDs"
 * crash on macOS Sequoia (15+) where the main binary and Electron Framework
 * end up with mismatched code signatures.
 */
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  console.log('  • re-signing macOS app bundle (ad-hoc):', appPath)
  execSync(`codesign --deep --force -s - "${appPath}"`, { stdio: 'inherit' })
}
