// Toggle for sounding charted vocal note pitches while the song plays
// (issues #10, #58). Shared between the MIDI editor's vocal pitch header and
// the chart preview's vocal track overlay so the option is visible wherever
// vocal notes are shown.
import { useUIStore } from '../stores'

export function VocalPitchPlaybackToggle({ showLabel = false }: { showLabel?: boolean }): React.JSX.Element {
  const enabled = useUIStore((s) => s.vocalPitchPlayback)
  const toggle = useUIStore((s) => s.toggleVocalPitchPlayback)
  return (
    <button
      title={enabled
        ? 'Pitch playback on: vocal note pitches sound while the song plays'
        : 'Pitch playback off: click to hear vocal note pitches while the song plays'}
      style={{
        fontSize: 10, padding: '1px 5px', border: 'none', borderRadius: 3,
        cursor: 'pointer', lineHeight: 1.4,
        backgroundColor: enabled ? '#E879F9' : 'rgba(255,255,255,0.15)',
        color: enabled ? '#000' : '#ccc',
        boxShadow: enabled ? '0 0 6px #E879F980' : 'none'
      }}
      onClick={toggle}
    >
      🔊{showLabel ? ' Pitch' : ''}
    </button>
  )
}
