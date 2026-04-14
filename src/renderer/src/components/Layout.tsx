// Main application layout with resizable panels (Unity/Unreal style)
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { useUIStore } from '../stores'
import { ProjectExplorer } from './ProjectExplorer'
import { ChartPreview } from './ChartPreview'
import { PropertyPanel } from './PropertyPanel'
import { BottomPanel } from './BottomPanel'
import { Toolbar } from './Toolbar'
import './Layout.css'

export function Layout(): React.JSX.Element {
  const { setFocusedPanel } = useUIStore()
  const isPreviewFullscreen = useUIStore((s) => s.isPreviewFullscreen)

  if (isPreviewFullscreen) {
    return (
      <div className="layout">
        <Toolbar />
        <div className="layout-main">
          <div className="panel panel-center" style={{ width: '100%', height: '100%' }} onFocus={() => setFocusedPanel('preview')}>
            <ChartPreview />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="layout">
      <Toolbar />
      <div className="layout-main">
        {/* Outer vertical split: top panels | bottom panel */}
        <Allotment vertical proportionalLayout={true}>
          {/* Top row: Explorer | Preview | Properties */}
          <Allotment.Pane preferredSize="70%" minSize={200}>
            <Allotment proportionalLayout={true}>
              {/* Left Panel - Project Explorer */}
              <Allotment.Pane preferredSize="18%" minSize={150} maxSize={400}>
                <div className="panel panel-left" onFocus={() => setFocusedPanel('explorer')}>
                  <ProjectExplorer />
                </div>
              </Allotment.Pane>

              {/* Center - Chart Preview */}
              <Allotment.Pane preferredSize="57%" minSize={300}>
                <div className="panel panel-center" onFocus={() => setFocusedPanel('preview')}>
                  <ChartPreview />
                </div>
              </Allotment.Pane>

              {/* Right Panel - Properties */}
              <Allotment.Pane preferredSize="25%" minSize={200} maxSize={500}>
                <div className="panel panel-right" onFocus={() => setFocusedPanel('properties')}>
                  <PropertyPanel />
                </div>
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>

          {/* Bottom - MIDI Editor / Video Editor (full width) */}
          <Allotment.Pane preferredSize="30%" minSize={100} maxSize={500}>
            <div className="panel panel-bottom">
              <BottomPanel />
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
