import { useEffect, useMemo, useState } from 'react'
import { useSettingsStore, useUIStore } from '../stores'
import type { AppHotkeys, HotkeyAction } from '../types'
import {
  cloneDefaultHotkeys,
  HOTKEY_ACTION_LABELS,
  HOTKEY_GROUPS,
  keyboardEventToHotkey,
  normalizeHotkey
} from '../utils/hotkeys'
import './SettingsModal.css'

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

export function SettingsModal(): React.JSX.Element | null {
  const isOpen = useUIStore((s) => s.isSettingsModalOpen)
  const setSettingsModalOpen = useUIStore((s) => s.setSettingsModalOpen)
  const hotkeys = useSettingsStore((s) => s.hotkeys)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [recordingAction, setRecordingAction] = useState<HotkeyAction | null>(null)
  const [draftHotkeys, setDraftHotkeys] = useState<AppHotkeys>(hotkeys)

  useEffect(() => {
    if (isOpen) {
      setDraftHotkeys(hotkeys)
      setRecordingAction(null)
    }
  }, [hotkeys, isOpen])

  const conflictMap = useMemo(() => {
    const buckets = new Map<string, HotkeyAction[]>()
    for (const [action, hotkey] of Object.entries(draftHotkeys) as Array<[HotkeyAction, string]>) {
      const normalized = normalizeHotkey(hotkey)
      if (!normalized) continue
      const existing = buckets.get(normalized) || []
      existing.push(action)
      buckets.set(normalized, existing)
    }

    const conflicts = new Map<HotkeyAction, string>()
    for (const [hotkey, actions] of buckets) {
      if (actions.length < 2) continue
      for (const action of actions) {
        conflicts.set(action, hotkey)
      }
    }
    return conflicts
  }, [draftHotkeys])

  const hasConflicts = conflictMap.size > 0

  useEffect(() => {
    if (!isOpen || !recordingAction) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecordingAction(null)
        return
      }

      if (MODIFIER_KEYS.has(event.key)) return

      const nextHotkey = normalizeHotkey(keyboardEventToHotkey(event))
      if (!nextHotkey) return

      setDraftHotkeys((prev) => ({
        ...prev,
        [recordingAction]: nextHotkey
      }))
      setRecordingAction(null)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, recordingAction])

  if (!isOpen) return null

  return (
    <div className="settings-modal-overlay" onClick={() => setSettingsModalOpen(false)}>
      <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal-header">
          <div>
            <h2 className="settings-modal-title">Settings</h2>
            <p className="settings-modal-subtitle">Change editor hotkeys. Click a binding, then press the new key combination.</p>
          </div>
          <button className="settings-modal-close" onClick={() => setSettingsModalOpen(false)} aria-label="Close settings">
            X
          </button>
        </div>

        <div className="settings-modal-body">
          {hasConflicts && (
            <div className="settings-hotkey-conflicts-banner">
              Resolve duplicate bindings before saving. Conflicting shortcuts are highlighted below.
            </div>
          )}
          {HOTKEY_GROUPS.map((group) => (
            <section key={group.title} className="settings-hotkey-group">
              <h3 className="settings-hotkey-group-title">{group.title}</h3>
              <div className="settings-hotkey-list">
                {group.actions.map((action) => {
                  const isRecording = recordingAction === action
                  const currentHotkey = draftHotkeys[action]
                  const defaultHotkey = cloneDefaultHotkeys()[action]
                  const hasConflict = conflictMap.has(action)
                  return (
                    <div key={action} className={`settings-hotkey-row${hasConflict ? ' has-conflict' : ''}`}>
                      <div className="settings-hotkey-meta">
                        <span className="settings-hotkey-label">{HOTKEY_ACTION_LABELS[action]}</span>
                        {hasConflict && (
                          <span className="settings-hotkey-conflict-text">
                            Conflicts with another action on {conflictMap.get(action)}
                          </span>
                        )}
                      </div>
                      <button
                        className={`settings-hotkey-button${isRecording ? ' is-recording' : ''}${hasConflict ? ' has-conflict' : ''}`}
                        onClick={() => setRecordingAction(isRecording ? null : action)}
                      >
                        {isRecording ? 'Press keys...' : currentHotkey || 'Unassigned'}
                      </button>
                      <div className="settings-hotkey-actions">
                        <button
                          className="settings-hotkey-clear"
                          onClick={() => setDraftHotkeys((prev) => ({ ...prev, [action]: defaultHotkey }))}
                          title={`Reset ${HOTKEY_ACTION_LABELS[action]} to default (${defaultHotkey})`}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="settings-modal-footer">
          <button
            className="settings-modal-secondary"
            onClick={() => setDraftHotkeys(cloneDefaultHotkeys())}
          >
            Reset All to Defaults
          </button>
          <button className="settings-modal-secondary" onClick={() => setSettingsModalOpen(false)}>
            Cancel
          </button>
          <button
            className="settings-modal-primary"
            disabled={hasConflicts}
            onClick={() => {
              updateSettings({ hotkeys: draftHotkeys })
              setSettingsModalOpen(false)
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
