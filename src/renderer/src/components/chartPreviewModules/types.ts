// Shared types for ChartPreview components
import * as THREE from 'three'

export interface HitEffect {
  id: string
  instrumentKey: string
  laneIndex: number
  color: string
  startTick: number
  endTick: number
  x: number
}

export interface ExtractedMesh {
  geometry: THREE.BufferGeometry
  groups: { start: number; count: number; materialIndex: number }[]
  materialCount: number
  name: string
}

export interface YARGAssets {
  noteGeo: THREE.BufferGeometry
  hopoGeo: THREE.BufferGeometry
  tapGeo: THREE.BufferGeometry
  ghostGeo: THREE.BufferGeometry
  accentGeo: THREE.BufferGeometry
  cymbalGeo: THREE.BufferGeometry
  fretMeshes: ExtractedMesh[]
  drumFretBaseGeo: THREE.BufferGeometry
  drumFretTopGeo: THREE.BufferGeometry
  kickGeo: THREE.BufferGeometry
  kickFretMeshes: ExtractedMesh[]
  trackTrimGroup: THREE.Group
  noteMap: THREE.Texture
  noteEmission: THREE.Texture
  fretMap: THREE.Texture
  fretShine: THREE.Texture
  kickMap: THREE.Texture
  kickFretMap: THREE.Texture
  trackTrimMap: THREE.Texture
  sidePattern: THREE.Texture
}

export type { EditingTool } from '../../types'
