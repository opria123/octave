// Bottom Panel - Tabbed panel with MIDI editor and timeline
import { useUIStore } from '../stores'
import { MidiEditor } from './MidiEditor'
import { VideoEditor } from './VideoEditor'
import './BottomPanel.css'

export function BottomPanel({ showMidi = true, showVideo = true }: { showMidi?: boolean; showVideo?: boolean }): React.JSX.Element {
  const { bottomPanelTab, setBottomPanelTab, setFocusedPanel } = useUIStore()
  const effectiveTab = showMidi
    ? (showVideo ? bottomPanelTab : 'midi')
    : 'video'

  if (!showMidi && !showVideo) {
    return (
      <div className="bottom-panel">
        <div className="empty-state" style={{ height: '100%' }}>
          <div className="empty-state-icon">🧰</div>
          <div className="empty-state-title">Bottom Panels Hidden</div>
          <div className="empty-state-description">Use View menu to re-enable Piano Roll or Timeline.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="bottom-panel">
      {/* Tab header */}
      <div className="panel-tabs">
        {showMidi && (
          <button
            className={`panel-tab ${effectiveTab === 'midi' ? 'active' : ''}`}
            onClick={() => setBottomPanelTab('midi')}
          >
            🎹 Piano Roll
          </button>
        )}
        {showVideo && (
          <button
            className={`panel-tab ${effectiveTab === 'video' ? 'active' : ''}`}
            onClick={() => setBottomPanelTab('video')}
          >
            🎬 Timeline
          </button>
        )}
      </div>

      {/* Tab content */}
      <div
        className="bottom-panel-content"
        onFocus={() => setFocusedPanel(effectiveTab)}
      >
        {effectiveTab === 'midi' ? <MidiEditor /> : <VideoEditor />}
      </div>
    </div>
  )
}
