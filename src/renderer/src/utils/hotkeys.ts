import type { AppHotkeys, HotkeyAction } from '../types'

export const DEFAULT_HOTKEYS: AppHotkeys = {
  openSettings: 'Ctrl+,',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  save: 'Ctrl+S',
  selectAll: 'Ctrl+A',
  createStarPower: 'Ctrl+P',
  createSolo: 'Ctrl+L',
  playPause: 'Space',
  deleteSelection: 'Delete',
  toolSelect: '1',
  toolPlace: '2',
  toolErase: '3',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  resetZoom: 'Ctrl+0',
  nudgeLeft: 'ArrowLeft',
  nudgeRight: 'ArrowRight',
  nudgeUp: 'ArrowUp',
  nudgeDown: 'ArrowDown',
  toggleCymbalOrTap: 'S',
  toggleGhostOrHopo: 'G',
  toggleAccent: 'F',
  toggleOpenOrKick: 'O',
  toggleStarPower: 'P',
  toggleSolo: 'L',
  toggleTalkie: 'T'
}

export const HOTKEY_ACTION_LABELS: Record<HotkeyAction, string> = {
  openSettings: 'Open Settings',
  undo: 'Undo',
  redo: 'Redo',
  copy: 'Copy',
  paste: 'Paste',
  save: 'Save',
  selectAll: 'Select All',
  createStarPower: 'Create Star Power from Selection',
  createSolo: 'Create Solo from Selection',
  playPause: 'Play/Pause',
  deleteSelection: 'Delete Selection',
  toolSelect: 'Select Tool',
  toolPlace: 'Place Tool',
  toolErase: 'Erase Tool',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  resetZoom: 'Reset Zoom',
  nudgeLeft: 'Nudge Left',
  nudgeRight: 'Nudge Right',
  nudgeUp: 'Nudge Up / Fret +1',
  nudgeDown: 'Nudge Down / Fret -1',
  toggleCymbalOrTap: 'Toggle Cymbal/Tap',
  toggleGhostOrHopo: 'Toggle Ghost/HOPO',
  toggleAccent: 'Toggle Accent',
  toggleOpenOrKick: 'Toggle Open/Kick',
  toggleStarPower: 'Toggle Star Power Mode',
  toggleSolo: 'Toggle Solo Mode',
  toggleTalkie: 'Toggle Talkie Mode'
}

export const HOTKEY_GROUPS: Array<{ title: string; actions: HotkeyAction[] }> = [
  {
    title: 'General',
    actions: ['openSettings', 'undo', 'redo', 'copy', 'paste', 'save', 'selectAll', 'playPause', 'deleteSelection']
  },
  {
    title: 'Placement',
    actions: ['createStarPower', 'createSolo', 'toolSelect', 'toolPlace', 'toolErase', 'zoomIn', 'zoomOut', 'resetZoom']
  },
  {
    title: 'Movement',
    actions: ['nudgeLeft', 'nudgeRight', 'nudgeUp', 'nudgeDown']
  },
  {
    title: 'Modifiers',
    actions: ['toggleCymbalOrTap', 'toggleGhostOrHopo', 'toggleAccent', 'toggleOpenOrKick', 'toggleStarPower', 'toggleSolo', 'toggleTalkie']
  }
]

function normalizeKeyName(key: string): string {
  if (key === ' ') return 'Space'
  if (key === 'Spacebar') return 'Space'
  if (key === 'Esc') return 'Escape'
  if (key.length === 1) return key.toUpperCase()
  return key
}

export function normalizeHotkey(input: string): string {
  const parts = input
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  const modifiers = new Set<string>()
  let key = ''

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') {
      modifiers.add('Ctrl')
    } else if (lower === 'shift') {
      modifiers.add('Shift')
    } else if (lower === 'alt' || lower === 'option') {
      modifiers.add('Alt')
    } else {
      key = normalizeKeyName(part)
    }
  }

  if (!key) return ''

  return [
    modifiers.has('Ctrl') ? 'Ctrl' : '',
    modifiers.has('Shift') ? 'Shift' : '',
    modifiers.has('Alt') ? 'Alt' : '',
    key
  ].filter(Boolean).join('+')
}

export function keyboardEventToHotkey(event: KeyboardEvent): string {
  const key = normalizeKeyName(event.key)
  const parts = [
    event.ctrlKey || event.metaKey ? 'Ctrl' : '',
    event.shiftKey ? 'Shift' : '',
    event.altKey ? 'Alt' : '',
    key
  ].filter(Boolean)

  return normalizeHotkey(parts.join('+'))
}

export function matchesHotkey(event: KeyboardEvent, hotkey: string | undefined): boolean {
  if (!hotkey) return false
  return keyboardEventToHotkey(event) === normalizeHotkey(hotkey)
}

export function cloneDefaultHotkeys(): AppHotkeys {
  return { ...DEFAULT_HOTKEYS }
}
