// Bottom Panel - Tabbed panel with MIDI editor and Video editor
import { useUIStore } from '../stores'
import { MidiEditor } from './MidiEditor'
import { VideoEditor } from './VideoEditor'
import './BottomPanel.css'

export function BottomPanel(): React.JSX.Element {
  const { bottomPanelTab, setBottomPanelTab, setFocusedPanel } = useUIStore()

  return (
    <div className="bottom-panel">
      {/* Tab header */}
      <div className="panel-tabs">
        <button
          className={`panel-tab ${bottomPanelTab === 'midi' ? 'active' : ''}`}
          onClick={() => setBottomPanelTab('midi')}
        >
          🎹 Piano Roll
        </button>
        <button
          className={`panel-tab ${bottomPanelTab === 'video' ? 'active' : ''}`}
          onClick={() => setBottomPanelTab('video')}
        >
          🎬 Video Editor
        </button>
      </div>

      {/* Tab content */}
      <div
        className="bottom-panel-content"
        onFocus={() => setFocusedPanel(bottomPanelTab)}
      >
        {bottomPanelTab === 'midi' ? <MidiEditor /> : <VideoEditor />}
      </div>
    </div>
  )
}
