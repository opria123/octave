// FBX Geometry Extraction Utilities
import * as THREE from 'three'
import { UNITY_IMPORT_SCALE } from './constants'
import type { ExtractedMesh } from './types'

// Extracts geometry from an FBX Group, bakes the mesh's world transform
// into the vertices, and applies Unity's 0.01 import scale.
export function extractBakedGeometry(
  scene: THREE.Group,
  fallback: [number, number, number],
  debugLabel?: string
): THREE.BufferGeometry {
  scene.updateWorldMatrix(true, true)

  let found: THREE.BufferGeometry | null = null

  scene.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const cloned = mesh.geometry.clone()
      cloned.applyMatrix4(mesh.matrixWorld)
      found = cloned
    }
  })

  if (!found) return new THREE.BoxGeometry(...fallback)

  const geo: THREE.BufferGeometry = found

  geo.scale(UNITY_IMPORT_SCALE, UNITY_IMPORT_SCALE, UNITY_IMPORT_SCALE)

  geo.computeBoundingBox()
  let box = geo.boundingBox!
  const sizeX = box.max.x - box.min.x
  const sizeY = box.max.y - box.min.y
  const sizeZ = box.max.z - box.min.z

  if (debugLabel) {
    console.log(`[FBX] ${debugLabel}: size X=${sizeX.toFixed(3)} Y=${sizeY.toFixed(3)} Z=${sizeZ.toFixed(3)}`)
  }

  if (sizeY > sizeX * 1.5 && sizeY > sizeZ * 1.5) {
    if (debugLabel) console.log(`[FBX] ${debugLabel}: rotating -90° X to lay flat`)
    geo.rotateX(-Math.PI / 2)
    geo.computeBoundingBox()
    box = geo.boundingBox!
  }

  const cx = (box.max.x + box.min.x) / 2
  const cz = (box.max.z + box.min.z) / 2
  geo.translate(-cx, -box.min.y, -cz)

  return geo
}

// Extracts an FBX as a ready-to-use Group with proper scale applied
export function extractBakedGroup(scene: THREE.Group): THREE.Group {
  const clone = scene.clone(true)
  clone.scale.multiplyScalar(UNITY_IMPORT_SCALE)
  clone.updateWorldMatrix(true, true)
  return clone
}

// Extracts ALL meshes from an FBX, bakes world transforms, applies Unity 0.01 scale,
// and centers them together around a common origin.
export function extractAllMeshes(
  scene: THREE.Group,
  debugLabel?: string
): ExtractedMesh[] {
  scene.updateWorldMatrix(true, true)

  const meshes: ExtractedMesh[] = []
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      const cloned = mesh.geometry.clone()
      cloned.applyMatrix4(mesh.matrixWorld)
      cloned.scale(UNITY_IMPORT_SCALE, UNITY_IMPORT_SCALE, UNITY_IMPORT_SCALE)
      cloned.computeBoundingBox()

      const matCount = Array.isArray(mesh.material) ? mesh.material.length : 1
      const groups = cloned.groups?.length > 0
        ? cloned.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 }))
        : []

      meshes.push({
        geometry: cloned,
        groups,
        materialCount: matCount,
        name: mesh.name
      })
    }
  })

  if (meshes.length === 0) return []

  const combined = new THREE.Box3()
  for (const m of meshes) {
    combined.union(m.geometry.boundingBox!)
  }

  const sizeY = combined.max.y - combined.min.y
  const sizeX = combined.max.x - combined.min.x
  const sizeZ = combined.max.z - combined.min.z

  const needsRotation = sizeY > sizeX * 1.5 && sizeY > sizeZ * 1.5

  if (debugLabel) {
    console.log(`[FBX-multi] ${debugLabel}: ${meshes.length} meshes, combined size X=${sizeX.toFixed(3)} Y=${sizeY.toFixed(3)} Z=${sizeZ.toFixed(3)} rotate=${needsRotation}`)
  }

  if (needsRotation) {
    const rotMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
    for (const m of meshes) {
      m.geometry.applyMatrix4(rotMatrix)
      m.geometry.computeBoundingBox()
    }
    combined.makeEmpty()
    for (const m of meshes) {
      combined.union(m.geometry.boundingBox!)
    }
  }

  const cx = (combined.max.x + combined.min.x) / 2
  const cz = (combined.max.z + combined.min.z) / 2
  const cy = combined.min.y

  for (const m of meshes) {
    m.geometry.translate(-cx, -cy, -cz)
    m.geometry.computeBoundingBox()
  }

  return meshes
}
