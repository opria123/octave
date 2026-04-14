// Keyboard shortcuts hook - handles global keyboard commands
import { useEffect, useCallback } from 'react'
import { useProjectStore, useUIStore, getSongStore } from '../stores'
import * as playbackController from '../services/playbackController'

let kbPlayPauseBusy = false

export function useKeyboardShortcuts(): void {
  const { activeSongId } = useProjectStore()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Get the active song store
      const songStore = activeSongId ? getSongStore(activeSongId) : null

      // Ctrl/Cmd modifier
      const isCtrlOrCmd = e.ctrlKey || e.metaKey

      // Undo (Ctrl+Z) - scoped to focused panel's song
      if (isCtrlOrCmd && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (songStore) {
          const temporal = songStore.temporal
          temporal.getState().undo()
        }
        return
      }

      // Redo (Ctrl+Y or Ctrl+Shift+Z) - scoped to focused panel's song
      if (isCtrlOrCmd && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        if (songStore) {
          const temporal = songStore.temporal
          temporal.getState().redo()
        }
        return
      }

      // Copy (Ctrl+C)
      if (isCtrlOrCmd && e.key === 'c' && !isInputElement(e.target as HTMLElement)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().copySelectedNotes()
        }
        return
      }

      // Paste (Ctrl+V)
      if (isCtrlOrCmd && e.key === 'v' && !isInputElement(e.target as HTMLElement)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().pasteNotes()
        }
        return
      }

      // Save (Ctrl+S)
      if (isCtrlOrCmd && e.key === 's') {
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
      if (isCtrlOrCmd && e.key === 'p' && !isInputElement(e.target as HTMLElement)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().createStarPowerFromSelection()
        }
        return
      }

      // Create Solo from selection (Ctrl+L)
      if (isCtrlOrCmd && e.key === 'l' && !isInputElement(e.target as HTMLElement)) {
        e.preventDefault()
        if (songStore) {
          songStore.getState().createSoloFromSelection()
        }
        return
      }

      // Play/Pause (Space) - only when not in an input
      if (e.key === ' ' && !isInputElement(e.target as HTMLElement)) {
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputElement(e.target as HTMLElement)) {
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
      if (isCtrlOrCmd && e.key === 'a' && !isInputElement(e.target as HTMLElement)) {
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
      if (isCtrlOrCmd && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          songStore.getState().setZoomLevel(state.zoomLevel * 1.25)
        }
        return
      }

      if (isCtrlOrCmd && e.key === '-') {
        e.preventDefault()
        if (songStore) {
          const state = songStore.getState()
          songStore.getState().setZoomLevel(state.zoomLevel * 0.8)
        }
        return
      }

      // Pro Guitar/Bass fret nudge — arrows ±1
      if (!isCtrlOrCmd && !isInputElement(e.target as HTMLElement) && songStore) {
        const state = songStore.getState()
        const selectedIds = state.selectedNoteIds
        if (selectedIds.length > 0) {
          const selectedNotes = state.song.notes.filter((n) => selectedIds.includes(n.id))
          const proNotes = selectedNotes.filter(
            (n) => n.instrument === 'proGuitar' || n.instrument === 'proBass'
          )
          if (proNotes.length > 0) {
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              for (const note of proNotes) {
                const newFret = Math.min(22, (note.fret ?? 0) + 1)
                songStore.getState().updateNote(note.id, { fret: newFret })
              }
              return
            }
            if (e.key === 'ArrowDown') {
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
      if (!isCtrlOrCmd && !isInputElement(e.target as HTMLElement)) {
        switch (e.key) {
          case '1': useUIStore.getState().setEditTool('select'); return
          case '2': useUIStore.getState().setEditTool('place'); return
          case '3': useUIStore.getState().setEditTool('erase'); return
          // Note modifier toggles
          case 's': case 'S': useUIStore.getState().toggleModifier('cymbalOrTap'); return
          case 'g': case 'G': useUIStore.getState().toggleModifier('ghostOrHopo'); return
          case 'f': case 'F': useUIStore.getState().toggleModifier('accent'); return
          case 'o': case 'O': useUIStore.getState().toggleModifier('openOrKick'); return
          case 'p': case 'P': useUIStore.getState().toggleModifier('starPower'); return
          case 'l': case 'L': useUIStore.getState().toggleModifier('solo'); return
        }
      }

      // Reset zoom (Ctrl+0)
      if (isCtrlOrCmd && e.key === '0') {
        e.preventDefault()
        if (songStore) {
          songStore.getState().setZoomLevel(1)
        }
        return
      }
    },
    [activeSongId]
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
