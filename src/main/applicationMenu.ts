import type { MenuItemConstructorOptions } from 'electron'

type ApplicationMenuOptions = {
  version: string
  sendCommand: (command: string, payload?: unknown) => void
  openExternal: (url: string) => void
}

export function createApplicationMenuTemplate({
  version,
  sendCommand,
  openExternal
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('file:new-song')
        },
        {
          label: 'Open',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendCommand('file:open-folder')
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendCommand('file:open-settings')
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'view-panel-explorer',
          label: 'File Explorer',
          type: 'checkbox',
          checked: true,
          click: (item) =>
            sendCommand('view:toggle-panel', { panel: 'explorer', visible: item.checked })
        },
        {
          id: 'view-panel-preview',
          label: 'Preview',
          type: 'checkbox',
          checked: true,
          click: (item) =>
            sendCommand('view:toggle-panel', { panel: 'preview', visible: item.checked })
        },
        {
          id: 'view-panel-properties',
          label: 'Properties',
          type: 'checkbox',
          checked: true,
          click: (item) =>
            sendCommand('view:toggle-panel', { panel: 'properties', visible: item.checked })
        },
        { type: 'separator' },
        {
          id: 'view-panel-midi',
          label: 'Piano Roll',
          type: 'checkbox',
          checked: true,
          click: (item) =>
            sendCommand('view:toggle-panel', { panel: 'midi', visible: item.checked })
        },
        {
          id: 'view-panel-video',
          label: 'Timeline',
          type: 'checkbox',
          checked: true,
          click: (item) =>
            sendCommand('view:toggle-panel', { panel: 'video', visible: item.checked })
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `Version ${version}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'GitHub Repository',
          click: () => openExternal('https://github.com/opria123/octave')
        },
        {
          label: 'Support',
          click: () => openExternal('https://github.com/opria123/octave/issues')
        },
        { type: 'separator' },
        {
          label: 'Third-Party Licenses',
          click: () =>
            openExternal('https://github.com/opria123/octave/blob/master/THIRD-PARTY-NOTICES.md')
        }
      ]
    }
  ]
}
