import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, Menu, type MenuItemConstructorOptions } from 'electron'
import { join, resolve, basename } from 'path'
import { readdir, readFile, writeFile, stat, rename, copyFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater, type UpdateDownloadedEvent } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import ffmpeg from 'fluent-ffmpeg'

// Point fluent-ffmpeg at the bundled static binary
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath = require('ffmpeg-static') as string
  ffmpeg.setFfmpegPath(ffmpegPath)
} catch {
  console.warn('[FFmpeg] ffmpeg-static not found — export will use system ffmpeg if available')
}

// Allow AudioContext to start without user gesture requirement in Electron
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Track the currently opened project folder for path validation
let allowedProjectPath: string | null = null

type UpdaterState = {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  version?: string
  percent?: number
  message?: string
}

const RELEASES_URL = 'https://github.com/opria123/octave/releases/latest'

function broadcastUpdaterState(payload: UpdaterState): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('updater:status', payload)
  }
}

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

async function isMacAutoInstallSupported(): Promise<boolean> {
  if (process.platform !== 'darwin') return true

  const appBundlePath = resolve(process.execPath, '../..')

  return new Promise((resolveSupport) => {
    execFile('codesign', ['-dv', '--verbose=4', appBundlePath], (error, _stdout, stderr) => {
      if (error) {
        console.warn('[Updater] Could not inspect macOS signature. Assuming manual update flow.', error)
        resolveSupport(false)
        return
      }

      const details = String(stderr ?? '')
      const isAdHoc = details.includes('Signature=adhoc')
      const hasAuthority = /Authority=/i.test(details)
      resolveSupport(!isAdHoc && hasAuthority)
    })
  })
}

async function handleMacCustomInstall(downloadedFile: string, version: string): Promise<void> {
  const win = getMainWindow()
  if (!win) return

  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update Ready',
    message: `OCTAVE v${version} is ready to install`,
    detail: 'The app will close and restart to apply the update. You may be prompted for your administrator password.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1
  })

  if (response !== 0) return

  const currentAppBundle = resolve(process.execPath, '../../..')  // /Applications/OCTAVE.app
  const tempDir = join(app.getPath('temp'), 'octave-update-' + version + '-' + Date.now())
  const scriptPath = join(app.getPath('temp'), 'octave-update-' + Date.now() + '.sh')

  const lines = [
    '#!/bin/bash',
    'sleep 2',
    '',
    "TEMP_DIR='" + tempDir + "'",
    "DOWNLOADED='" + downloadedFile + "'",
    "CURRENT_APP='" + currentAppBundle + "'",
    "SELF='" + scriptPath + "'",
    '',
    'mkdir -p "$TEMP_DIR"',
    'unzip -q -o "$DOWNLOADED" -d "$TEMP_DIR"',
    '',
    'NEW_APP=$(find "$TEMP_DIR" -maxdepth 2 -name "*.app" -type d | head -1)',
    'if [ -z "$NEW_APP" ]; then',
    '  open "$CURRENT_APP"',
    '  rm -rf "$TEMP_DIR"',
    '  rm -f "$SELF"',
    '  exit 1',
    'fi',
    '',
    '# Replace app bundle — try directly first, fall back to admin prompt',
    'if rm -rf "$CURRENT_APP" 2>/dev/null && cp -R "$NEW_APP" "$CURRENT_APP" 2>/dev/null; then',
    '  true',
    'else',
    '  osascript -e "do shell script \\"rm -rf \'$CURRENT_APP\' && cp -R \'$NEW_APP\' \'$CURRENT_APP\'\\" with administrator privileges" 2>/dev/null || true',
    'fi',
    '',
    '# Clear Gatekeeper quarantine flag',
    'xattr -dr com.apple.quarantine "$CURRENT_APP" 2>/dev/null || true',
    '# Re-sign with ad-hoc identity so macOS will launch the updated binary',
    'codesign --force --deep --sign - "$CURRENT_APP" 2>/dev/null || true',
    '',
    'open "$CURRENT_APP"',
    '',
    'rm -rf "$TEMP_DIR"',
    'rm -f "$SELF"',
    ''
  ]

  await writeFile(scriptPath, lines.join('\n'), { mode: 0o755 })

  const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()

  app.quit()
}

/** Validate that a path is within the allowed project folder */
function isPathAllowed(targetPath: string): boolean {
  if (!allowedProjectPath) return true // No project opened yet — allow (dialog-gated)
  const resolved = resolve(targetPath)
  // Ensure the path is exactly or a child of the allowed folder (not just a prefix match)
  return resolved === allowedProjectPath || resolved.startsWith(allowedProjectPath + '/') || resolved.startsWith(allowedProjectPath + '\\')
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // Required for preload Node.js APIs
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.setMenuBarVisibility(true)
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendMenuCommand(command: string, payload?: unknown): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.webContents.send('menu:command', { command, payload })
}

function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuCommand('file:new-song')
        },
        {
          label: 'Open',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuCommand('file:open-folder')
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'File Explorer',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuCommand('view:toggle-panel', { panel: 'explorer', visible: item.checked })
        },
        {
          label: 'Preview',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuCommand('view:toggle-panel', { panel: 'preview', visible: item.checked })
        },
        {
          label: 'Properties',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuCommand('view:toggle-panel', { panel: 'properties', visible: item.checked })
        },
        { type: 'separator' },
        {
          label: 'Piano Roll',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuCommand('view:toggle-panel', { panel: 'midi', visible: item.checked })
        },
        {
          label: 'Video Editor',
          type: 'checkbox',
          checked: true,
          click: (item) => sendMenuCommand('view:toggle-panel', { panel: 'video', visible: item.checked })
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => {
            void shell.openExternal('https://github.com/opria123/octave')
          }
        },
        {
          label: 'Support',
          click: () => {
            void shell.openExternal('https://github.com/opria123/octave/issues')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// Register custom protocol scheme for streaming local audio files
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'song-file',
    privileges: { stream: true, supportFetchAPI: true }
  }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.opria123.octave')

  // Register protocol handler: song-file://<encoded-path>
  // Only allows access to files within the currently opened project folder
  protocol.handle('song-file', (request) => {
    const raw = request.url.replace('song-file://', '')
    const filePath = decodeURIComponent(raw)
    const resolved = resolve(filePath)

    // Validate: only allow access to files within a known project folder
    if (allowedProjectPath && !resolved.startsWith(allowedProjectPath)) {
      console.error('[song-file] Blocked access outside project folder:', resolved)
      return new Response('Forbidden', { status: 403 })
    }

    const normalized = resolved.replace(/\\/g, '/')
    // On macOS/Linux paths start with /, so file:// + /path = file:///path (correct)
    // On Windows we need file:/// + C:/path
    const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
    return net.fetch(fileUrl)
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()
  createApplicationMenu()

  // Check for updates after window is ready (skip in dev)
  if (!is.dev) {
    let macAutoInstallSupported = true
    if (process.platform === 'darwin') {
      void isMacAutoInstallSupported().then((supported) => {
        macAutoInstallSupported = supported
        if (!supported) {
          console.warn('[Updater] macOS auto-install disabled: app is unsigned/ad-hoc signed.')
        }
      })
    }

    autoUpdater.autoDownload = false
    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for updates...')
      broadcastUpdaterState({ state: 'checking' })
    })
    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] No updates available.')
      const win = getMainWindow()
      win?.setProgressBar(-1)
      broadcastUpdaterState({ state: 'not-available' })
    })
    autoUpdater.on('update-available', (info) => {
      const win = getMainWindow()
      if (!win) return
      broadcastUpdaterState({ state: 'available', version: info.version })
      dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'Update Available',
          message: `A new version (v${info.version}) is available.`,
          detail: 'Would you like to download and install it now?',
          buttons: ['Update', 'Later'],
          defaultId: 0,
          cancelId: 1
        })
        .then(({ response }) => {
          if (response === 0) {
            win.setProgressBar(0)
            broadcastUpdaterState({ state: 'downloading', version: info.version, percent: 0 })
            autoUpdater.downloadUpdate().catch((error) => {
              console.error('[Updater] downloadUpdate failed:', error)
            })
          }
        })
    })
    autoUpdater.on('download-progress', (progress) => {
      const win = getMainWindow()
      const clamped = Math.max(0, Math.min(100, progress.percent))
      if (win) {
        win.setProgressBar(clamped / 100)
      }
      broadcastUpdaterState({
        state: 'downloading',
        percent: clamped,
        message: `${Math.round(clamped)}%`
      })
    })
    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      const win = getMainWindow()
      if (!win) return
      win.setProgressBar(-1)
      broadcastUpdaterState({ state: 'downloaded', percent: 100 })

      if (process.platform === 'darwin' && !macAutoInstallSupported) {
        void handleMacCustomInstall(event.downloadedFile, event.version)
        return
      }

      dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'Update Ready',
          message: 'Update downloaded. The app will restart to apply it.',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
          cancelId: 1
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall()
          }
        })
    })
    autoUpdater.on('error', (error) => {
      console.error('[Updater] Failed:', error)
      const win = getMainWindow()
      win?.setProgressBar(-1)

      const rawMessage = String(error instanceof Error ? error.message : error)
      const isMacSignatureFailure =
        process.platform === 'darwin'
        && /code signature|did not pass validation|code requirement/i.test(rawMessage)

      broadcastUpdaterState({
        state: 'error',
        message: isMacSignatureFailure
          ? 'macOS update install failed: code-signature validation. Use manual DMG install.'
          : rawMessage
      })

      if (!win) return
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: isMacSignatureFailure ? 'Update Install Failed' : 'Update Check Failed',
        message: isMacSignatureFailure
          ? 'macOS could not validate the downloaded app update.'
          : 'Could not check for updates.',
        detail: isMacSignatureFailure
          ? `${rawMessage}\n\nThis happens with unsigned or ad-hoc signed builds. Please install the latest DMG manually from:\n${RELEASES_URL}`
          : rawMessage
      })
    })
    autoUpdater.checkForUpdates().catch((error) => {
      console.error('[Updater] checkForUpdates failed:', error)
    })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

// ============================================
// IPC Handlers for Chart Editor
// ============================================

// Open folder dialog
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Songs Folder'
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  // Track the opened project folder for path validation
  allowedProjectPath = resolve(result.filePaths[0])
  return result.filePaths[0]
})

// Open audio file dialog
ipcMain.handle('dialog:openAudio', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Select Audio File',
    filters: [
      { name: 'Audio Files', extensions: ['ogg', 'mp3', 'opus', 'wav'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Scan folder for song directories (folders containing song.ini)
ipcMain.handle('folder:scan', async (_event, folderPath: string) => {
  // Set allowedProjectPath so auto-reloaded folders also get security boundary
  if (!allowedProjectPath) {
    allowedProjectPath = resolve(folderPath)
  }
  const songs: Array<{ id: string; path: string; name: string }> = []

  try {
    // Check if the opened folder itself is a song (contains song.ini)
    const selfIniPath = join(folderPath, 'song.ini')
    try {
      await stat(selfIniPath)
      const folderName = folderPath.split(/[\\/]/).pop() || 'song'
      songs.push({
        id: folderName,
        path: folderPath,
        name: folderName
      })
    } catch {
      // Not a song folder itself — scan children
    }

    // Also scan child directories for songs
    const entries = await readdir(folderPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const songPath = join(folderPath, entry.name)
        const iniPath = join(songPath, 'song.ini')

        try {
          await stat(iniPath)
          songs.push({
            id: entry.name,
            path: songPath,
            name: entry.name
          })
        } catch {
          // No song.ini, skip this folder
        }
      }
    }
  } catch (error) {
    console.error('Error scanning folder:', error)
  }

  return songs
})

// Create a new song folder with a default song.ini
ipcMain.handle('song:createFolder', async (_event, parentPath: string, folderName: string, audioSourcePath?: string) => {
  if (!isPathAllowed(parentPath)) return null
  // Sanitize folder name
  const safeName = folderName.replace(/[<>:"/\\|?*]/g, '_').trim()
  if (!safeName) return null
  const songPath = join(parentPath, safeName)
  try {
    await mkdir(songPath, { recursive: true })
    // Write a minimal song.ini
    const ini = `[song]\nname = ${safeName}\nartist = Unknown Artist\ncharter = OCTAVE\n`
    await writeFile(join(songPath, 'song.ini'), ini, 'utf-8')
    // Copy audio file into song folder if provided
    if (audioSourcePath) {
      const audioName = basename(audioSourcePath)
      await copyFile(audioSourcePath, join(songPath, audioName))
    }
    // Update allowed path to include this new folder
    allowedProjectPath = resolve(parentPath)
    return { id: safeName, path: songPath, name: safeName }
  } catch (error) {
    console.error('Error creating song folder:', error)
    return null
  }
})

// Delete a song folder (moves to OS trash)
ipcMain.handle('song:deleteFolder', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return false
  try {
    await shell.trashItem(resolve(songPath))
    return true
  } catch (error) {
    console.error('Error deleting song folder:', error)
    return false
  }
})

// Read song.ini file
ipcMain.handle('song:readIni', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const iniPath = join(songPath, 'song.ini')

  try {
    const content = await readFile(iniPath, 'utf-8')
    return parseIniFile(content)
  } catch (error) {
    console.error('Error reading song.ini:', error)
    return null
  }
})

// Write song.ini file
ipcMain.handle('song:writeIni', async (_event, songPath: string, metadata: Record<string, unknown>) => {
  if (!isPathAllowed(songPath)) return false
  const iniPath = join(songPath, 'song.ini')

  try {
    const content = serializeIniFile(metadata)
    await writeFile(iniPath, content, 'utf-8')
    return true
  } catch (error) {
    console.error('Error writing song.ini:', error)
    return false
  }
})

// Read notes.mid file (also returns chart format info)
ipcMain.handle('song:readMidi', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const midiPath = join(songPath, 'notes.mid')
  const chartPath = join(songPath, 'notes.chart')

  try {
    const buffer = await readFile(midiPath)
    // Verify it's a real MIDI file (starts with "MThd")
    if (buffer.length >= 4 && buffer[0] === 0x4D && buffer[1] === 0x54 && buffer[2] === 0x68 && buffer[3] === 0x64) {
      return { type: 'midi', data: buffer.toString('base64') }
    }
    console.warn('notes.mid exists but is not a valid MIDI file:', midiPath)
    return null
  } catch {
    // notes.mid not found — try notes.chart
    try {
      const chartBuffer = await readFile(chartPath, 'utf-8')
      console.log('Loading notes.chart:', chartPath)
      return { type: 'chart', data: chartBuffer }
    } catch {
      // Neither file found
      return null
    }
  }
})

// Write notes.mid file — with backup + validation + atomic write
const MAX_BACKUPS = 3

ipcMain.handle('song:writeMidi', async (_event, songPath: string, midiBase64: string) => {
  if (!isPathAllowed(songPath)) return false
  const midiPath = join(songPath, 'notes.mid')
  const tempPath = join(songPath, 'notes.mid.tmp')

  try {
    const buffer = Buffer.from(midiBase64, 'base64')

    // 1. Validate: must be a real MIDI file (MThd header) with meaningful content
    if (buffer.length < 14) {
      console.error('Refusing to write notes.mid — file too small:', buffer.length, 'bytes')
      return false
    }
    if (buffer[0] !== 0x4D || buffer[1] !== 0x54 || buffer[2] !== 0x68 || buffer[3] !== 0x64) {
      console.error('Refusing to write notes.mid — invalid MIDI header')
      return false
    }
    // A header-only MIDI with no tracks is ~14-22 bytes; require at least some track data
    if (buffer.length < 50) {
      console.error('Refusing to write notes.mid — no track data, only', buffer.length, 'bytes')
      return false
    }

    // 2. Backup: rotate existing file before overwriting (keep last N backups)
    if (existsSync(midiPath)) {
      try {
        // Rotate backups: .bak3 → delete, .bak2 → .bak3, .bak1 → .bak2, current → .bak1
        for (let i = MAX_BACKUPS; i >= 1; i--) {
          const older = join(songPath, `notes.mid.bak${i}`)
          if (i === MAX_BACKUPS) {
            if (existsSync(older)) await unlink(older)
          } else {
            const newer = join(songPath, `notes.mid.bak${i + 1}`)
            if (existsSync(older)) await rename(older, newer)
          }
        }
        await copyFile(midiPath, join(songPath, 'notes.mid.bak1'))
      } catch (backupErr) {
        console.warn('Backup rotation failed (continuing save):', backupErr)
      }
    }

    // 3. Atomic write: write to temp file, then rename over original
    await writeFile(tempPath, buffer)
    await rename(tempPath, midiPath)

    return true
  } catch (error) {
    console.error('Error writing notes.mid:', error)
    // Clean up temp file if it exists
    try { if (existsSync(tempPath)) await unlink(tempPath) } catch { /* ignore */ }
    return false
  }
})

// Write notes.chart file — with backup + atomic write
ipcMain.handle('song:writeChart', async (_event, songPath: string, chartText: string) => {
  if (!isPathAllowed(songPath)) return false
  const chartPath = join(songPath, 'notes.chart')
  const tempPath = join(songPath, 'notes.chart.tmp')

  try {
    if (!chartText || chartText.length < 20) {
      console.error('Refusing to write notes.chart — content too small:', chartText?.length)
      return false
    }

    // Backup: rotate existing file before overwriting
    if (existsSync(chartPath)) {
      try {
        for (let i = MAX_BACKUPS; i >= 1; i--) {
          const older = join(songPath, `notes.chart.bak${i}`)
          if (i === MAX_BACKUPS) {
            if (existsSync(older)) await unlink(older)
          } else {
            const newer = join(songPath, `notes.chart.bak${i + 1}`)
            if (existsSync(older)) await rename(older, newer)
          }
        }
        await copyFile(chartPath, join(songPath, 'notes.chart.bak1'))
      } catch (backupErr) {
        console.warn('Chart backup rotation failed (continuing save):', backupErr)
      }
    }

    // Atomic write: write to temp file, then rename
    await writeFile(tempPath, chartText, 'utf-8')
    await rename(tempPath, chartPath)

    return true
  } catch (error) {
    console.error('Error writing notes.chart:', error)
    try { if (existsSync(tempPath)) await unlink(tempPath) } catch { /* ignore */ }
    return false
  }
})

// Read video.json (video sync/clip data)
ipcMain.handle('video:readJson', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const jsonPath = join(songPath, 'video.json')
  try {
    const content = await readFile(jsonPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
})

// Write video.json (video sync/clip data)
ipcMain.handle('video:writeJson', async (_event, songPath: string, data: unknown) => {
  if (!isPathAllowed(songPath)) return false
  const jsonPath = join(songPath, 'video.json')
  try {
    await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('Error writing video.json:', error)
    return false
  }
})

// Read album art (album.png, album.jpg, or album.jpeg)
ipcMain.handle('song:readAlbumArt', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const extensions = ['png', 'jpg', 'jpeg']

  for (const ext of extensions) {
    const artPath = join(songPath, `album.${ext}`)
    try {
      const buffer = await readFile(artPath)
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      // Try next extension
    }
  }

  return null
})

// Write album art
ipcMain.handle('song:writeAlbumArt', async (_event, songPath: string, dataUrl: string) => {
  if (!isPathAllowed(songPath)) return false
  try {
    // Parse data URL
    const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
    if (!matches) return false

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1]
    const base64Data = matches[2]
    const buffer = Buffer.from(base64Data, 'base64')

    const artPath = join(songPath, `album.${ext}`)
    await writeFile(artPath, buffer)
    return true
  } catch (error) {
    console.error('Error writing album art:', error)
    return false
  }
})

// Import an audio file into an existing song folder
ipcMain.handle('song:importAudio', async (_event, songPath: string, audioSourcePath: string) => {
  if (!isPathAllowed(songPath)) return null
  try {
    const filename = basename(audioSourcePath)
    const destPath = join(songPath, filename)
    // Only copy if source isn't already in the song folder
    const srcDir = audioSourcePath.substring(0, audioSourcePath.lastIndexOf(basename(audioSourcePath)) - 1)
    if (srcDir !== songPath) {
      await copyFile(audioSourcePath, destPath)
    }
    return { filePath: destPath, filename }
  } catch (error) {
    console.error('Error importing audio:', error)
    return null
  }
})

// Read audio files - returns all audio stems found in the song folder
ipcMain.handle('song:readAudio', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const audioExtensions = ['.ogg', '.mp3', '.opus', '.wav']
  const results: { filePath: string; filename: string }[] = []

  try {
    const entries = await readdir(songPath)
    for (const entry of entries) {
      const ext = entry.substring(entry.lastIndexOf('.')).toLowerCase()
      if (audioExtensions.includes(ext)) {
        const audioPath = join(songPath, entry)
        try {
          await stat(audioPath)
          results.push({ filePath: audioPath, filename: entry })
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Folder not readable
  }

  return results.length > 0 ? results : null
})

// Parse INI file content
function parseIniFile(content: string): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  const lines = content.split(/\r?\n/)
  let inSongSection = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Section header
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSongSection = trimmed.toLowerCase() === '[song]'
      continue
    }

    // Key-value pair
    if (inSongSection && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=')
      const value = valueParts.join('=').trim()

      // Try to parse as number
      const numValue = parseFloat(value)
      result[key.trim()] = isNaN(numValue) ? value : numValue
    }
  }

  return result
}

// Serialize metadata to INI format
function serializeIniFile(metadata: Record<string, unknown>): string {
  const lines = ['[song]']

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null && value !== '') {
      lines.push(`${key} = ${value}`)
    }
  }

  return lines.join('\n')
}

// ============================================
// Video Import IPC Handlers
// ============================================

// Open video file dialog
ipcMain.handle('dialog:openVideo', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Import Video',
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Copy video into song folder so it's portable
ipcMain.handle('video:import', async (_event, songPath: string, videoSourcePath: string) => {
  if (!isPathAllowed(songPath)) return null
  try {
    const ext = videoSourcePath.substring(videoSourcePath.lastIndexOf('.')).toLowerCase()
    const destFilename = `video${ext}`
    const destPath = join(songPath, destFilename)
    // Only copy if source isn't already in the song folder
    const srcDir = resolve(videoSourcePath, '..')
    if (srcDir !== resolve(songPath)) {
      await copyFile(videoSourcePath, destPath)
    }
    return { filePath: destPath, filename: destFilename }
  } catch (error) {
    console.error('Error importing video:', error)
    return null
  }
})

// Scan song folder for existing video files
ipcMain.handle('video:scan', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv']
  try {
    const entries = await readdir(songPath)
    for (const entry of entries) {
      const ext = entry.substring(entry.lastIndexOf('.')).toLowerCase()
      if (videoExtensions.includes(ext)) {
        const videoPath = join(songPath, entry)
        try {
          await stat(videoPath)
          return { filePath: videoPath, filename: entry }
        } catch { /* skip */ }
      }
    }
  } catch { /* folder not readable */ }
  return null
})

// Download video from URL (YouTube, etc.) using yt-dlp
ipcMain.handle('video:download-url', async (event, songPath: string, url: string) => {
  if (!isPathAllowed(songPath)) return { success: false, error: 'Invalid path' }
  // Validate URL scheme — only allow http(s)
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { success: false, error: 'Only HTTP/HTTPS URLs are allowed' }
    }
  } catch {
    return { success: false, error: 'Invalid URL' }
  }
  const outputTemplate = join(songPath, 'video.%(ext)s')
  const args = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-playlist',
    '--progress',
    '--newline',
    url
  ]

  return new Promise<{ success: boolean; filePath?: string; error?: string }>((resolvePromise) => {
    console.log('[yt-dlp] Starting download:', url)
    const proc = execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[yt-dlp] Error:', error.message)
        console.error('[yt-dlp] stderr:', stderr)
        resolvePromise({ success: false, error: error.message })
        return
      }
      console.log('[yt-dlp] Done:', stdout.slice(-200))
      // Find the output file (video.mp4 or similar)
      const expectedPath = join(songPath, 'video.mp4')
      if (existsSync(expectedPath)) {
        resolvePromise({ success: true, filePath: expectedPath })
      } else {
        // Look for any video.* file
        readdir(songPath).then((entries) => {
          const videoFile = entries.find((e) => e.startsWith('video.') && !e.endsWith('.part'))
          if (videoFile) {
            resolvePromise({ success: true, filePath: join(songPath, videoFile) })
          } else {
            resolvePromise({ success: false, error: 'Download completed but output file not found' })
          }
        }).catch(() => resolvePromise({ success: false, error: 'Could not read output directory' }))
      }
    })

    // Forward progress to renderer
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString()
        const match = line.match(/(\d+\.?\d*)%/)
        if (match) {
          const percent = parseFloat(match[1])
          event.sender.send('video:download-progress', percent)
        }
      })
    }
    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        const line = data.toString()
        const match = line.match(/(\d+\.?\d*)%/)
        if (match) {
          const percent = parseFloat(match[1])
          event.sender.send('video:download-progress', percent)
        }
      })
    }
  })
})

// Get audio waveform data - returns peak amplitude samples for visualization
ipcMain.handle('audio:waveform', async (_event, songPath: string) => {
  if (!isPathAllowed(songPath)) return null
  const audioExtensions = ['.ogg', '.mp3', '.opus', '.wav']
  try {
    const entries = await readdir(songPath)
    // Find the first audio file (preferring song.ogg or similar)
    let audioFile: string | null = null
    for (const entry of entries) {
      const ext = entry.substring(entry.lastIndexOf('.')).toLowerCase()
      if (audioExtensions.includes(ext)) {
        audioFile = join(songPath, entry)
        break
      }
    }
    if (!audioFile) return null
    // Return the file path so renderer can process it via Web Audio API
    return { filePath: audioFile }
  } catch {
    return null
  }
})

// ============================================
// Video Export IPC Handlers
// ============================================

// Open save dialog for export
ipcMain.handle('dialog:saveVideo', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Export Video',
    defaultPath: 'chart-export.mp4',
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'WebM Video', extensions: ['webm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
})

// Export video with audio overlay
ipcMain.handle('video:export', async (event, options: {
  videoPath: string
  audioPath: string
  outputPath: string
  offsetMs: number
  trimStartMs: number
  trimEndMs: number
}) => {
  const { videoPath, audioPath, outputPath, offsetMs, trimStartMs, trimEndMs } = options
  const win = BrowserWindow.fromWebContents(event.sender)

  return new Promise<{ success: boolean; error?: string }>((promiseResolve) => {
    const trimStartSec = trimStartMs / 1000
    const offsetSec = offsetMs / 1000
    const absVideoPath = resolve(videoPath)
    const absAudioPath = resolve(audioPath)

    let cmd = ffmpeg()
      .input(absVideoPath)
      .inputOptions(trimStartSec > 0 ? [`-ss ${trimStartSec}`] : [])

    if (trimEndMs > 0) {
      const durationSec = (trimEndMs - trimStartMs) / 1000
      cmd = cmd.inputOptions([`-t ${durationSec}`])
    }

    // Add audio with offset
    cmd = cmd.input(absAudioPath)
    if (offsetSec !== 0) {
      cmd = cmd.inputOptions([`-itsoffset ${-offsetSec}`])
    }

    cmd
      .outputOptions([
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-y' // overwrite
      ])
      .output(resolve(outputPath))
      .on('progress', (progress) => {
        if (win && progress.percent) {
          win.webContents.send('video:export-progress', Math.round(progress.percent))
        }
      })
      .on('end', () => {
        promiseResolve({ success: true })
      })
      .on('error', (err: Error) => {
        console.error('[FFmpeg] Export error:', err.message)
        promiseResolve({ success: false, error: err.message })
      })
      .run()
  })
})
