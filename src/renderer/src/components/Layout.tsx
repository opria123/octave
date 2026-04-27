// Main application layout with resizable panels (Unity/Unreal style)
import { useEffect, useMemo, useState } from 'react'
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
  type PanelName = 'explorer' | 'preview' | 'properties' | 'midi' | 'video'
  const [panelVisible, setPanelVisible] = useState({
    explorer: true,
    preview: true,
    properties: true,
    midi: true,
    video: true
  })

  useEffect(() => {
    return window.api.onMenuCommand((command, payload) => {
      if (command !== 'view:toggle-panel') return
      const data = payload as { panel?: string; visible?: boolean } | undefined
      if (!data?.panel || typeof data.visible !== 'boolean') return
      const validPanels: PanelName[] = ['explorer', 'preview', 'properties', 'midi', 'video']
      if (!validPanels.includes(data.panel as PanelName)) return
      setPanelVisible((prev) => {
        const panel = data.panel as PanelName
        return { ...prev, [panel]: data.visible }
      })
    })
  }, [])

  const hasTopPanel = panelVisible.explorer || panelVisible.preview || panelVisible.properties
  const hasBottomPanel = panelVisible.midi || panelVisible.video

  const topPaneConfig = useMemo(() => ({
    explorer: panelVisible.explorer
      ? { preferredSize: '18%' as const, minSize: 150, maxSize: 400 }
      : { preferredSize: 0, minSize: 0, maxSize: 0 },
    preview: panelVisible.preview
      ? { preferredSize: '57%' as const, minSize: 300, maxSize: undefined }
      : { preferredSize: 0, minSize: 0, maxSize: 0 },
    properties: panelVisible.properties
      ? { preferredSize: '25%' as const, minSize: 200, maxSize: 500 }
      : { preferredSize: 0, minSize: 0, maxSize: 0 }
  }), [panelVisible.explorer, panelVisible.preview, panelVisible.properties])

  const topContent = !hasTopPanel ? (
    <div className="panel panel-center" style={{ width: '100%', height: '100%' }}>
      <div className="empty-state">
        <div className="empty-state-icon">🪟</div>
        <div className="empty-state-title">All Top Panels Hidden</div>
        <div className="empty-state-description">Use View menu to re-enable Explorer, Preview, or Properties.</div>
      </div>
    </div>
  ) : (
    <Allotment proportionalLayout={true}>
      <Allotment.Pane
        preferredSize={topPaneConfig.explorer.preferredSize}
        minSize={topPaneConfig.explorer.minSize}
        maxSize={topPaneConfig.explorer.maxSize}
      >
        {panelVisible.explorer && (
          <div className="panel panel-left" onFocus={() => setFocusedPanel('explorer')}>
            <ProjectExplorer />
          </div>
        )}
      </Allotment.Pane>

      <Allotment.Pane
        preferredSize={topPaneConfig.preview.preferredSize}
        minSize={topPaneConfig.preview.minSize}
        maxSize={topPaneConfig.preview.maxSize}
      >
        {panelVisible.preview && (
          <div className="panel panel-center" onFocus={() => setFocusedPanel('preview')}>
            <ChartPreview />
          </div>
        )}
      </Allotment.Pane>

      <Allotment.Pane
        preferredSize={topPaneConfig.properties.preferredSize}
        minSize={topPaneConfig.properties.minSize}
        maxSize={topPaneConfig.properties.maxSize}
      >
        {panelVisible.properties && (
          <div className="panel panel-right" onFocus={() => setFocusedPanel('properties')}>
            <PropertyPanel />
          </div>
        )}
      </Allotment.Pane>
    </Allotment>
  )

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
        <Allotment vertical proportionalLayout={true}>
          <Allotment.Pane
            preferredSize={hasBottomPanel ? (hasTopPanel ? '70%' : 0) : '100%'}
            minSize={hasTopPanel ? 200 : 0}
            maxSize={hasTopPanel ? undefined : 0}
          >
            {topContent}
          </Allotment.Pane>

          <Allotment.Pane
            preferredSize={hasBottomPanel ? (hasTopPanel ? '30%' : '100%') : 0}
            minSize={hasBottomPanel ? 100 : 0}
            maxSize={hasBottomPanel ? 500 : 0}
          >
            {hasBottomPanel && (
              <div className="panel panel-bottom">
                <BottomPanel showMidi={panelVisible.midi} showVideo={panelVisible.video} />
              </div>
            )}
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
