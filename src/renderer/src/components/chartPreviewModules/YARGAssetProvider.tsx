// YARG Asset Provider - Loads FBX models and textures into context
import { useMemo, createContext } from 'react'
import { useFBX, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { extractBakedGeometry, extractBakedGroup, extractAllMeshes } from './fbxUtils'
import { TRACK_WIDTH } from './constants'
import type { YARGAssets } from './types'

export const YARGAssetsContext = createContext<YARGAssets | null>(null)

export function YARGAssetProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const normalFBX = useFBX('/yarg/models/NormalNote.fbx')
  const hopoFBX = useFBX('/yarg/models/HOPONote.fbx')
  const tapFBX = useFBX('/yarg/models/TapNote.fbx')
  const ghostFBX = useFBX('/yarg/models/GhostNote.fbx')
  const accentFBX = useFBX('/yarg/models/AccentNote.fbx')
  const cymbalFBX = useFBX('/yarg/models/CymbalNote.fbx')
  const fretFBX = useFBX('/yarg/models/RectangularFret.fbx')
  const drumFretBaseFBX = useFBX('/yarg/models/CircularFretBase.fbx')
  const drumFretTopFBX = useFBX('/yarg/models/CircularFretTop.fbx')
  const kickFBX = useFBX('/yarg/models/KickNote.fbx')
  const kickFretFBX = useFBX('/yarg/models/RectangularKickFret.fbx')
  const trackTrimFBX = useFBX('/yarg/models/TrackTrim.fbx')

  const [
    noteMap, noteEmission, fretMap, fretShine, kickMap,
    kickFretMap, trackTrimMap, sidePattern
  ] = useTexture([
    '/yarg/textures/NormalNote.png',
    '/yarg/textures/NormalNoteEmission.png',
    '/yarg/textures/RectangularFret.png',
    '/yarg/textures/RectangularFretShine.png',
    '/yarg/textures/KickNote.png',
    '/yarg/textures/RectangularKickFret.png',
    '/yarg/textures/TrackTrim.png',
    '/yarg/textures/SidePattern_Default.png'
  ])

  useMemo(() => {
    sidePattern.wrapS = sidePattern.wrapT = THREE.RepeatWrapping
    trackTrimMap.wrapS = trackTrimMap.wrapT = THREE.RepeatWrapping
  }, [sidePattern, trackTrimMap])

  const assets = useMemo<YARGAssets>(() => {
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

  return <YARGAssetsContext.Provider value={assets}>{children}</YARGAssetsContext.Provider>
}
