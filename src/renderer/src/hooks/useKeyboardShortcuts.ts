// Keyboard shortcuts hook - handles global keyboard commands
import { useEffect, useCallback } from 'react'
import { useProjectStore, useSettingsStore, useUIStore, getSongStore } from '../stores'
import * as playbackController from '../services/playbackController'
import { matchesHotkey } from '../utils/hotkeys'

let kbPlayPauseBusy = false

export function useKeyboardShortcuts(): void {
  const { activeSongId } = useProjectStore()
  const hotkeys = useSettingsStore((s) => s.hotkeys)
  const setSettingsModalOpen = useUIStore((s) => s.setSettingsModalOpen)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement

      // Get the active song store
      const songStore = activeSongId ? getSongStore(activeSongId) : null

      // Ctrl/Cmd modifier
      const isCtrlOrCmd = e.ctrlKey || e.metaKey

      if (matchesHotkey(e, hotkeys.openSettings) && !isInputElement(target)) {
        e.preventDefault()
        setSettingsModalOpen(true)
        return
      }

      // Undo (Ctrl+Z) - scoped to focused panel's song
      if (matchesHotkey(e, hotkeys.undo) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const temporal = songStore.temporal
          temporal.getState().undo()
        }
        return
      }

      // Redo (Ctrl+Y or Ctrl+Shift+Z) - scoped to focused panel's song
      if (matchesHotkey(e, hotkeys.redo) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const temporal = songStore.temporal
          temporal.getState().redo()
        }
        return
      }

      // Copy (Ctrl+C)
      if (matchesHotkey(e, hotkeys.copy) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          if (state.selectedVocalNoteIds.length > 0) {
            songStore.getState().copySelectedVocalNotes()
          } else {
            songStore.getState().copySelectedNotes()
          }
        }
        return
      }

      // Paste (Ctrl+V)
      if (matchesHotkey(e, hotkeys.paste) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          if (state.vocalClipboard.length > 0) {
            songStore.getState().pasteVocalNotes()
          } else {
            songStore.getState().pasteNotes()
          }
        }
        return
      }

      // Save (Ctrl+S)
      if (matchesHotkey(e, hotkeys.save)) {
        e.preventDefault()
        if (songStore) {
          // Trigger manual save
          const state = songStore.getState()
          window.api.writeSongIni(state.song.folderPath, state.song.metadata)
          songStore.getState().markClean()
        }
        return
      }

      // Create Star Power from selection (Ctrl+P)
      if (matchesHotkey(e, hotkeys.createStarPower) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().createStarPowerFromSelection()
        }
        return
      }

      // Create Solo from selection (Ctrl+L)
      if (matchesHotkey(e, hotkeys.createSolo) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().createSoloFromSelection()
        }
        return
      }

      // Play/Pause (Space) - only when not in an input
      if (matchesHotkey(e, hotkeys.playPause) && !isInputElement(target)) {
        e.preventDefault()
        if (activeSongId && !kbPlayPauseBusy) {
          kbPlayPauseBusy = true
          
          playbackController.togglePlayback(activeSongId).finally(() => {
            kbPlayPauseBusy = false
          })
        }
        return
      }

      // Delete selected notes or SP phrase (Delete or Backspace)
      if ((matchesHotkey(e, hotkeys.deleteSelection) || e.key === 'Backspace') && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          if (state.selectedSpId) {
            songStore.getState().deleteStarPowerPhrase(state.selectedSpId)
          } else if (state.selectedSoloId) {
            songStore.getState().deleteSoloSection(state.selectedSoloId)
          } else if (state.selectedVocalNoteIds.length > 0) {
            songStore.getState().deleteSelectedVocalNotes()
          } else {
            songStore.getState().deleteSelectedNotes()
          }
        }
        return
      }

      // Select all (Ctrl+A) - select all notes in current view
      if (matchesHotkey(e, hotkeys.selectAll) && !isInputElement(target)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          const noteIds = state.song.notes
            .filter((n) => n.difficulty === state.activeDifficulty)
            .map((n) => n.id)
          songStore.getState().selectNotes(noteIds)
        }
        return
      }

      // Escape - exit fullscreen or clear selection
      if (e.key === 'Escape') {
        if (useUIStore.getState().isPreviewFullscreen) {
          useUIStore.getState().togglePreviewFullscreen()
          return
        }
        if (songStore) {
          songStore.getState().clearSelection()
        }
        return
      }

      // Zoom shortcuts
      if (matchesHotkey(e, hotkeys.zoomIn)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          songStore.getState().setZoomLevel(state.zoomLevel * 1.25)
        }
        return
      }

      if (matchesHotkey(e, hotkeys.zoomOut)) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          songStore.getState().setZoomLevel(state.zoomLevel * 0.8)
        }
        return
      }

      // Arrow key nudges — only when not in an input and there are selected notes
      if (!isCtrlOrCmd && !isInputElement(e.target as HTMLElement) && songStore) {
        const state = songStore.getState()

        // Left/Right: nudge selected notes (or vocal notes) by one snap division in time
        if (matchesHotkey(e, hotkeys.nudgeLeft) || matchesHotkey(e, hotkeys.nudgeRight)) {
          const snapTicks = 480 / state.snapDivision
          const delta = matchesHotkey(e, hotkeys.nudgeLeft) ? -snapTicks : snapTicks
          if (state.selectedNoteIds.length > 0) {
            e.preventDefault()
            const minTick = Math.min(...state.selectedNoteIds.map((id) => {
              const n = state.song.notes.find((nn) => nn.id === id)
              return n ? n.tick : 0
            }))
            if (minTick + delta < 0) return // don't nudge before tick 0
            for (const id of state.selectedNoteIds) {
              const note = state.song.notes.find((n) => n.id === id)
              if (note) songStore.getState().updateNote(id, { tick: Math.max(0, note.tick + delta) })
            }
            return
          }
          if (state.selectedVocalNoteIds.length > 0) {
            e.preventDefault()
            const minTick = Math.min(...state.selectedVocalNoteIds.map((id) => {
              const n = state.song.vocalNotes.find((nn) => nn.id === id)
              return n ? n.tick : 0
            }))
            if (minTick + delta < 0) return
            for (const id of state.selectedVocalNoteIds) {
              const note = state.song.vocalNotes.find((n) => n.id === id)
              if (note) songStore.getState().updateVocalNote(id, { tick: Math.max(0, note.tick + delta) })
            }
            return
          }
        }

        // Up/Down: Pro Guitar/Bass fret nudge ±1
        const selectedIds = state.selectedNoteIds
        if (selectedIds.length > 0) {
          const selectedNotes = state.song.notes.filter((n) => selectedIds.includes(n.id))
          const proNotes = selectedNotes.filter(
            (n) => n.instrument === 'proGuitar' || n.instrument === 'proBass'
          )
          if (proNotes.length > 0) {
            if (matchesHotkey(e, hotkeys.nudgeUp)) {
              e.preventDefault()
              for (const note of proNotes) {
                const newFret = Math.min(22, (note.fret ?? 0) + 1)
                songStore.getState().updateNote(note.id, { fret: newFret })
              }
              return
            }
            if (matchesHotkey(e, hotkeys.nudgeDown)) {
              e.preventDefault()
              for (const note of proNotes) {
                const newFret = Math.max(0, (note.fret ?? 0) - 1)
                songStore.getState().updateNote(note.id, { fret: newFret })
              }
              return
            }
          }
        }
      }

      // Tool switching (1/2/3) and modifier toggles
      if (!isCtrlOrCmd && !isInputElement(target)) {
        if (matchesHotkey(e, hotkeys.toolSelect)) { useUIStore.getState().setEditTool('select'); return }
        if (matchesHotkey(e, hotkeys.toolPlace)) { useUIStore.getState().setEditTool('place'); return }
        if (matchesHotkey(e, hotkeys.toolErase)) { useUIStore.getState().setEditTool('erase'); return }
        if (matchesHotkey(e, hotkeys.toggleCymbalOrTap)) { useUIStore.getState().toggleModifier('cymbalOrTap'); return }
        if (matchesHotkey(e, hotkeys.toggleGhostOrHopo)) { useUIStore.getState().toggleModifier('ghostOrHopo'); return }
        if (matchesHotkey(e, hotkeys.toggleAccent)) { useUIStore.getState().toggleModifier('accent'); return }
        if (matchesHotkey(e, hotkeys.toggleOpenOrKick)) { useUIStore.getState().toggleModifier('openOrKick'); return }
        if (matchesHotkey(e, hotkeys.toggleStarPower)) { useUIStore.getState().toggleModifier('starPower'); return }
        if (matchesHotkey(e, hotkeys.toggleSolo)) { useUIStore.getState().toggleModifier('solo'); return }
        if (matchesHotkey(e, hotkeys.toggleTalkie)) { useUIStore.getState().toggleModifier('talkie'); return }
      }

      // Reset zoom (Ctrl+0)
      if (matchesHotkey(e, hotkeys.resetZoom)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().setZoomLevel(1)
        }
        return
      }
    },
    [activeSongId, hotkeys, setSettingsModalOpen]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

// Helper to check if the event target is an input element
function isInputElement(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || element.isContentEditable
}
