// Asset Provider - Loads FBX models and textures into context
import { useMemo, createContext } from 'react'
import { useFBX, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { extractBakedGeometry, extractBakedGroup, extractAllMeshes } from './fbxUtils'
import { TRACK_WIDTH } from './constants'
import type { HighwayAssets } from './types'

export const HighwayAssetsContext = createContext<HighwayAssets | null>(null)

export function AssetProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const normalFBX = useFBX('/highway-assets/models/NormalNote.fbx')
  const hopoFBX = useFBX('/highway-assets/models/HOPONote.fbx')
  const tapFBX = useFBX('/highway-assets/models/TapNote.fbx')
  const ghostFBX = useFBX('/highway-assets/models/GhostNote.fbx')
  const accentFBX = useFBX('/highway-assets/models/AccentNote.fbx')
  const cymbalFBX = useFBX('/highway-assets/models/CymbalNote.fbx')
  const fretFBX = useFBX('/highway-assets/models/RectangularFret.fbx')
  const drumFretBaseFBX = useFBX('/highway-assets/models/CircularFretBase.fbx')
  const drumFretTopFBX = useFBX('/highway-assets/models/CircularFretTop.fbx')
  const kickFBX = useFBX('/highway-assets/models/KickNote.fbx')
  const kickFretFBX = useFBX('/highway-assets/models/RectangularKickFret.fbx')
  const trackTrimFBX = useFBX('/highway-assets/models/TrackTrim.fbx')

  const [
    noteMap, noteEmission, fretMap, fretShine, kickMap,
    kickFretMap, trackTrimMap, sidePattern
  ] = useTexture([
    '/highway-assets/textures/NormalNote.png',
    '/highway-assets/textures/NormalNoteEmission.png',
    '/highway-assets/textures/RectangularFret.png',
    '/highway-assets/textures/RectangularFretShine.png',
    '/highway-assets/textures/KickNote.png',
    '/highway-assets/textures/RectangularKickFret.png',
    '/highway-assets/textures/TrackTrim.png',
    '/highway-assets/textures/SidePattern_Default.png'
  ])

  useMemo(() => {
    sidePattern.wrapS = sidePattern.wrapT = THREE.RepeatWrapping
    trackTrimMap.wrapS = trackTrimMap.wrapT = THREE.RepeatWrapping
  }, [sidePattern, trackTrimMap])

  const assets = useMemo<HighwayAssets>(() => {
    const noteFallback: [number, number, number] = [0.34, 0.06, 0.2]
    const drumFretFallback: [number, number, number] = [0.35, 0.03, 0.35]
    const kickFallback: [number, number, number] = [TRACK_WIDTH, 0.06, 0.15]

    return {
      noteGeo: extractBakedGeometry(normalFBX, noteFallback, 'NormalNote'),
      hopoGeo: extractBakedGeometry(hopoFBX, noteFallback, 'HOPONote'),
      tapGeo: extractBakedGeometry(tapFBX, noteFallback, 'TapNote'),
      ghostGeo: extractBakedGeometry(ghostFBX, noteFallback, 'GhostNote'),
      accentGeo: extractBakedGeometry(accentFBX, noteFallback, 'AccentNote'),
      cymbalGeo: extractBakedGeometry(cymbalFBX, noteFallback, 'CymbalNote'),
      fretMeshes: extractAllMeshes(fretFBX, 'RectangularFret'),
      drumFretBaseGeo: extractBakedGeometry(drumFretBaseFBX, drumFretFallback, 'CircularFretBase'),
      drumFretTopGeo: extractBakedGeometry(drumFretTopFBX, drumFretFallback, 'CircularFretTop'),
      kickGeo: extractBakedGeometry(kickFBX, kickFallback, 'KickNote'),
      kickFretMeshes: extractAllMeshes(kickFretFBX, 'RectangularKickFret'),
      trackTrimGroup: extractBakedGroup(trackTrimFBX),
      noteMap,
      noteEmission,
      fretMap,
      fretShine,
      kickMap,
      kickFretMap,
      trackTrimMap,
      sidePattern
    }
  }, [normalFBX, hopoFBX, tapFBX, ghostFBX, accentFBX, cymbalFBX, fretFBX,
      drumFretBaseFBX, drumFretTopFBX, kickFBX, kickFretFBX, trackTrimFBX,
      noteMap, noteEmission, fretMap, fretShine, kickMap, kickFretMap,
      trackTrimMap, sidePattern])

  return <HighwayAssetsContext.Provider value={assets}>{children}</HighwayAssetsContext.Provider>
}
