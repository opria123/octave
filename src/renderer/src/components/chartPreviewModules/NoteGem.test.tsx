import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { sharedGeometries } from './NoteGem'

describe('NoteGem Performance Optimization - Shared Geometries', () => {
  it('should instantiate shared geometries exactly once as static exports', () => {
    expect(sharedGeometries).toBeDefined()
    expect(sharedGeometries.noteGemFallback).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.selectionRing).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.sustainUnit).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.burnEdge).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.kickNoteFallback).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.kickSelection).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.kickSustainUnit).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.flashSphere).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.flashRing).toBeInstanceOf(THREE.BufferGeometry)
    expect(sharedGeometries.flashParticleUnit).toBeInstanceOf(THREE.BufferGeometry)
  })

  it('should have correct parameters for sustain unit box geometry to support Z-axis scaling', () => {
    // The sustain geometry must have length (depth) of 1 so it can be scaled along the Z-axis
    const sustainUnit = sharedGeometries.sustainUnit as THREE.BoxGeometry
    sustainUnit.computeBoundingBox()
    const size = new THREE.Vector3()
    sustainUnit.boundingBox?.getSize(size)
    
    // Width: 0.1, Height: 0.04, Depth (Z): 1.0 (for unit scaling)
    expect(size.x).toBeCloseTo(0.1)
    expect(size.y).toBeCloseTo(0.04)
    expect(size.z).toBeCloseTo(1.0)
  })

  it('should have correct parameters for kick sustain unit box geometry', () => {
    const kickSustainUnit = sharedGeometries.kickSustainUnit as THREE.BoxGeometry
    kickSustainUnit.computeBoundingBox()
    const size = new THREE.Vector3()
    kickSustainUnit.boundingBox?.getSize(size)

    expect(size.x).toBeCloseTo(3.27)
    expect(size.y).toBeCloseTo(0.04)
    expect(size.z).toBeCloseTo(1.0)
  })
})
