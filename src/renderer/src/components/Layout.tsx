// Main application layout with resizable panels (Unity/Unreal style)
import { useEffect, useMemo } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { useUIStore } from '../stores'
import type { LayoutPanelName } from '../types'
import { ProjectExplorer } from './ProjectExplorer'
import { ChartPreview } from './ChartPreview'
import { PropertyPanel } from './PropertyPanel'
import { BottomPanel } from './BottomPanel'
import { Toolbar } from './Toolbar'
import './Layout.css'

const TOP_PANELS: LayoutPanelName[] = ['explorer', 'preview', 'properties']
const VALID_PANELS: LayoutPanelName[] = ['explorer', 'preview', 'properties', 'midi', 'video']

/**
 * Allotment only reads `defaultSizes` when it mounts, so hidden panes must be
 * zeroed there; otherwise the saved width of a hidden pane would be laid out
 * and then clamped, shifting the visible ones.
 */
function initialSizes(saved: number[] | null, visible: boolean[]): number[] | undefined {
  if (!saved || saved.length !== visible.length) return undefined
  return saved.map((size, index) => (visible[index] ? size : 0))
}

/**
 * Merge freshly dragged sizes into the saved ones, keeping the last known size
 * of any pane that is currently hidden so it comes back at its old size.
 */
function rememberSizes(previous: number[] | null, next: number[], visible: boolean[]): number[] {
  return next.map((size, index) => {
    if (visible[index]) return size
    const old = previous?.[index]
    return typeof old === 'number' && old > 0 ? old : size
  })
}

export function Layout(): React.JSX.Element {
  const { setFocusedPanel, setSettingsModalOpen, setPanelVisible, setTopPaneSizes, setMainPaneSizes } = useUIStore()
  const isPreviewFullscreen = useUIStore((s) => s.isPreviewFullscreen)
  const panelVisible = useUIStore((s) => s.panelVisible)
  const topPaneSizes = useUIStore((s) => s.topPaneSizes)
  const mainPaneSizes = useUIStore((s) => s.mainPaneSizes)

  useEffect(() => {
    return window.api.onMenuCommand((command, payload) => {
      if (command === 'file:open-settings') {
        setSettingsModalOpen(true)
        return
      }
      if (command !== 'view:toggle-panel') return
      const data = payload as { panel?: string; visible?: boolean } | undefined
      if (!data?.panel || typeof data.visible !== 'boolean') return
      if (!VALID_PANELS.includes(data.panel as LayoutPanelName)) return
      setPanelVisible(data.panel as LayoutPanelName, data.visible)
    })
  }, [setSettingsModalOpen, setPanelVisible])

  // Keep the native View menu checkboxes in step with the persisted state,
  // both on startup (restored from a previous session) and after toggles.
  useEffect(() => {
    window.api.syncViewPanels?.(panelVisible)
  }, [panelVisible])

  const hasTopPanel = panelVisible.explorer || panelVisible.preview || panelVisible.properties
  const hasBottomPanel = panelVisible.midi || panelVisible.video

  const topVisible = useMemo(() => TOP_PANELS.map((panel) => panelVisible[panel]), [panelVisible])
  const mainVisible = useMemo(() => [hasTopPanel, hasBottomPanel], [hasTopPanel, hasBottomPanel])

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
    <Allotment
      proportionalLayout={true}
      defaultSizes={initialSizes(topPaneSizes, topVisible)}
      onDragEnd={(sizes) => setTopPaneSizes(rememberSizes(topPaneSizes, sizes, topVisible))}
    >
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
        <Allotment
          vertical
          proportionalLayout={true}
          defaultSizes={initialSizes(mainPaneSizes, mainVisible)}
          onDragEnd={(sizes) => setMainPaneSizes(rememberSizes(mainPaneSizes, sizes, mainVisible))}
        >
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
