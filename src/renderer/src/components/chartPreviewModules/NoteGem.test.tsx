import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

// Inline document canvas mock for headless Node environment execution tests
if (typeof global.document === 'undefined') {
  global.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => {},
        fillStyle: '',
        globalAlpha: 0,
        beginPath: () => {},
        arc: () => {},
        fill: () => {},
        strokeStyle: '',
        lineWidth: 0,
        stroke: () => {},
        font: '',
        textAlign: '',
        textBaseline: '',
        fillText: () => {},
        roundRect: () => {}
      })
    })
  } as any
}
import {
  sharedGeometries,
  getSharedNoteMaterial,
  getSharedSustainMaterial,
  clearMaterialCaches,
  NoteGem,
  KickNoteBar
} from './NoteGem'

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

describe('NoteGem Performance Optimization - Shared Materials Caching', () => {
  const dummyAssets1 = { noteMap: {} as THREE.Texture } as any
  const dummyAssets2 = { noteMap: {} as THREE.Texture } as any

  it('should cache and reuse standard note materials for identical parameters', () => {
    clearMaterialCaches()
    const mat1 = getSharedNoteMaterial('#FF0000', false, false, dummyAssets1)
    const mat2 = getSharedNoteMaterial('#FF0000', false, false, dummyAssets1)
    
    expect(mat1).toBe(mat2) // Reuses cached material
  })

  it('should create separate standard note materials for different parameters', () => {
    clearMaterialCaches()
    const matRed = getSharedNoteMaterial('#FF0000', false, false, dummyAssets1)
    const matBlue = getSharedNoteMaterial('#0000FF', false, false, dummyAssets1)
    const matSelected = getSharedNoteMaterial('#FF0000', true, false, dummyAssets1)
    const matGhost = getSharedNoteMaterial('#FF0000', false, true, dummyAssets1)

    expect(matRed).not.toBe(matBlue)
    expect(matRed).not.toBe(matSelected)
    expect(matRed).not.toBe(matGhost)
  })

  it('should clean up and rebuild material cache when song assets reference changes', () => {
    clearMaterialCaches()
    const mat1 = getSharedNoteMaterial('#FF0000', false, false, dummyAssets1)
    
    // Simulating loading a different song
    const mat2 = getSharedNoteMaterial('#FF0000', false, false, dummyAssets2)

    expect(mat1).not.toBe(mat2) // Dispose-recreate occurred
  })

  it('should cache and reuse sustain materials', () => {
    clearMaterialCaches()
    const mat1 = getSharedSustainMaterial('#FF0000', false, dummyAssets1)
    const mat2 = getSharedSustainMaterial('#FF0000', false, dummyAssets1)
    const matBurning = getSharedSustainMaterial('#FF0000', true, dummyAssets1)

    expect(mat1).toBe(mat2)
    expect(mat1).not.toBe(matBurning)
  })
})

describe('NoteGem and KickNoteBar Component Execution', () => {
  const dummyAssets = {
    noteMap: {} as THREE.Texture,
    noteEmission: {} as THREE.Texture,
    kickMap: {} as THREE.Texture,
    kickGeo: {} as THREE.BufferGeometry
  } as any

  it('should render NoteGemComponent without throwing errors', () => {
    expect(() => {
      (NoteGem as any).type({
        position: [0, 0, 0],
        color: '#FF0000',
        isSelected: false,
        sustainLength: 0,
        assets: null
      })
    }).not.toThrow()

    expect(() => {
      (NoteGem as any).type({
        position: [1, 2, 3],
        color: '#00FF00',
        isSelected: true,
        sustainLength: 10,
        assets: dummyAssets,
        isCymbal: true,
        fretNumber: 5
      })
    }).not.toThrow()
  })

  it('should render KickNoteBar without throwing errors', () => {
    expect(() => {
      (KickNoteBar as any).type({
        z: -10,
        color: '#FFCC00',
        assets: null,
        isSelected: false,
        sustainLength: 0,
        isSustainActive: false,
        showDoubleKickBadge: false
      })
    }).not.toThrow()

    expect(() => {
      (KickNoteBar as any).type({
        z: -5,
        color: '#FF00FF',
        assets: dummyAssets,
        isSelected: true,
        sustainLength: 20,
        isSustainActive: true,
        showDoubleKickBadge: true
      })
    }).not.toThrow()
  })
})


