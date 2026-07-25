// Strikeline and Fret Pads - YARG RectangularFret.prefab recreation
import { useMemo, useRef, useContext, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  TRACK_WIDTH, STRIKE_LINE_POS, COLORS, DRUM_KICK_COLOR,
  DRUM_FRET_SCALE_X, GUITAR_FRET_SCALE_X, FRET_INACTIVE_COLOR,
  getLaneConfig, getFretX, PRO_KEYS_COLOR, VOCAL_COLOR
} from './constants'
import type { InstrumentRenderType } from './constants'
import { HighwayAssetsContext } from './AssetProvider'

// Reusable static geometries at module level for static components
const strikelineBaseGeo = new THREE.BoxGeometry(TRACK_WIDTH + 0.14, 0.035, 0.06)
const strikelineGlowBarGeo = new THREE.BoxGeometry(TRACK_WIDTH + 0.14, 0.008, 0.025)
const strikelineUnderGlowGeo = new THREE.BoxGeometry(TRACK_WIDTH, 0.002, 0.16)
const simplifiedStrikelineGlowGeo = new THREE.BoxGeometry(TRACK_WIDTH * 0.96, 0.025, 0.12)
const drumKickGlowGeo = new THREE.BoxGeometry(TRACK_WIDTH * 0.95, 0.008, 0.08)

// Reusable static materials at module level for static components
const strikelineBaseMaterial = new THREE.MeshStandardMaterial({
  color: '#1a1a2e',
  metalness: 0.7,
  roughness: 0.3
})
const strikelineGlowBarMaterial = new THREE.MeshStandardMaterial({
  color: '#FFFFFF',
  emissive: '#4466CC',
  emissiveIntensity: 1.5,
  metalness: 0.9,
  roughness: 0.1,
  toneMapped: false
})
const strikelineUnderGlowMaterial = new THREE.MeshBasicMaterial({
  color: '#2244AA',
  transparent: true,
  opacity: 0.15,
  toneMapped: false
})

function FretPad({
  x,
  color,
  innerColor,
  isPressed,
  pressBrightness,
  isDrum,
  laneWidth
}: {
  x: number
  color: string
  innerColor: string
  isPressed: boolean
  pressBrightness: number
  isDrum: boolean
  laneWidth: number
}): React.JSX.Element {
  const assets = useContext(HighwayAssetsContext)
  const groupRef = useRef<THREE.Group>(null)
  const fretScaleX = isDrum ? DRUM_FRET_SCALE_X : GUITAR_FRET_SCALE_X

  useFrame(() => {
    if (groupRef.current) {
      const targetY = isPressed ? -0.003 : 0.0
      groupRef.current.position.y += (targetY - groupRef.current.position.y) * 0.3
    }
  })

  const outerEmissiveIntensity = isPressed ? 4.0 * pressBrightness : 0.3
  const innerEmissiveIntensity = isPressed ? 2.0 * pressBrightness : 0.0
  const activeOuterColor = color
  const activeInnerColor = isPressed ? innerColor : FRET_INACTIVE_COLOR

  const fretMeshes = assets?.fretMeshes
  const hasFBX = fretMeshes && fretMeshes.length >= 2

  // Create stable materials that are instantiated exactly once and never recreated
  const outerMat = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      metalness: 0.5,
      roughness: 0.3,
      toneMapped: false
    })
  }, [])

  const innerMat = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      metalness: 0.6,
      roughness: 0.35
    })
  }, [])

  const metalMat = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: '#888899',
      metalness: 0.85,
      roughness: 0.2
    })
  }, [])

  const pressFeedbackMat = useMemo(() => {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      toneMapped: false
    })
  }, [color])

  // Geometries memoized locally per fret lane width config
  const boxGeo1 = useMemo(() => new THREE.BoxGeometry(laneWidth * 0.85, 0.03, laneWidth * 0.55), [laneWidth])
  const boxGeo2 = useMemo(() => new THREE.BoxGeometry(laneWidth * 0.82, 0.008, laneWidth * 0.52), [laneWidth])
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(0.1, 12, 12), [])

  // Safely dispose of materials & geometries from GPU memory on unmount
  useEffect(() => {
    return () => {
      outerMat.dispose()
      innerMat.dispose()
      metalMat.dispose()
      pressFeedbackMat.dispose()
      boxGeo1.dispose()
      boxGeo2.dispose()
      sphereGeo.dispose()
    }
  }, [outerMat, innerMat, metalMat, pressFeedbackMat, boxGeo1, boxGeo2, sphereGeo])

  // Update material maps: only triggers when assets change
  useEffect(() => {
    outerMat.map = assets?.fretMap ?? null
    outerMat.needsUpdate = true
  }, [outerMat, assets?.fretMap])

  // Update material uniforms: color, emissive, intensity (cheap uniforms update on frame loop)
  useEffect(() => {
    outerMat.color.set(activeOuterColor)
    outerMat.emissive.set(isPressed ? color : '#111111')
    outerMat.emissiveIntensity = outerEmissiveIntensity
  }, [outerMat, activeOuterColor, isPressed, color, outerEmissiveIntensity])

  useEffect(() => {
    innerMat.color.set(activeInnerColor)
    innerMat.emissive.set(isPressed ? innerColor : '#080808')
    innerMat.emissiveIntensity = innerEmissiveIntensity
  }, [innerMat, activeInnerColor, isPressed, innerColor, innerEmissiveIntensity])

  useEffect(() => {
    pressFeedbackMat.opacity = 0.3 * pressBrightness
  }, [pressFeedbackMat, pressBrightness])

  const bodyMaterials = useMemo(() => [outerMat, innerMat], [outerMat, innerMat])

  return (
    <group ref={groupRef} position={[x, 0, STRIKE_LINE_POS]} scale={[fretScaleX, 1, 1]}>
      {hasFBX ? (
        <>
          <mesh geometry={fretMeshes[0].geometry} material={metalMat} />
          <mesh geometry={fretMeshes[1].geometry} material={bodyMaterials} />
        </>
      ) : (
        <>
          <mesh geometry={boxGeo1} material={innerMat} />
          <mesh position={[0, 0.02, 0]} geometry={boxGeo2} material={outerMat} />
        </>
      )}
      {isPressed && (
        <mesh position={[0, 0.04, 0]} geometry={sphereGeo} material={pressFeedbackMat} />
      )}
    </group>
  )
}

export function Strikeline({
  instrumentType,
  offsetX = 0,
  pressedLanes
}: {
  instrumentType: InstrumentRenderType
  offsetX?: number
  pressedLanes: { index: number; brightness: number }[]
}): React.JSX.Element {
  const isProKeys = instrumentType === 'proKeys'
  const isVocals = instrumentType === 'vocals'
  // proKeys/vocals get simplified strikeline — no individual fret pads
  const profile = isProKeys
    ? { notes: [PRO_KEYS_COLOR], fretInner: ['#5B4A8A'] }
    : isVocals
    ? { notes: [VOCAL_COLOR], fretInner: ['#9A4AAA'] }
    : instrumentType === 'proGuitar' ? COLORS.proGuitar : COLORS[instrumentType]
  const { laneCount, laneWidth } = getLaneConfig(instrumentType)
  const isDrum = instrumentType === 'drums'
  const assets = useContext(HighwayAssetsContext)

  // Memoized materials for dynamic strikeline overlays
  const simplifiedGlowMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: isProKeys ? PRO_KEYS_COLOR : VOCAL_COLOR,
      emissive: isProKeys ? PRO_KEYS_COLOR : VOCAL_COLOR,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.5,
      toneMapped: false
    })
  }, [isProKeys])

  const kickUnderGlowMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: DRUM_KICK_COLOR,
      emissive: DRUM_KICK_COLOR,
      transparent: true,
      toneMapped: false
    })
  }, [])

  const kickFretMaterialDrums = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: DRUM_KICK_COLOR,
      emissive: DRUM_KICK_COLOR,
      map: assets?.kickFretMap ?? null,
      metalness: 0.5,
      roughness: 0.3,
      toneMapped: false
    })
  }, [assets?.kickFretMap])

  const kickFretMaterialNonDrums = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: '#9933FF',
      emissive: '#6622AA',
      emissiveIntensity: 0.5,
      map: assets?.kickFretMap ?? null,
      metalness: 0.5,
      roughness: 0.3
    })
  }, [assets?.kickFretMap])

  // Custom memoized lane glow materials & geometries
  const laneGlowMaterials = useMemo(() => {
    return profile.notes.map((color) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      toneMapped: false
    }))
  }, [profile.notes])

  const laneGlowGeo = useMemo(() => new THREE.BoxGeometry(laneWidth * 0.9, 0.003, 0.25), [laneWidth])
  const kickFlashGeo = useMemo(() => new THREE.BoxGeometry(TRACK_WIDTH, 0.004, 0.16), [])
  const kickFlashMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: DRUM_KICK_COLOR,
    transparent: true,
    depthWrite: false,
    toneMapped: false
  }), [])

  // Find active kick presses for drums
  const kickPress = pressedLanes.find((p) => p.index === -1)
  const kickBrightness = kickPress?.brightness ?? 0

  // Apply frame loop updates to materials uniforms/opacities without compiling shaders
  useEffect(() => {
    kickUnderGlowMaterial.emissiveIntensity = 0.5 + kickBrightness * 1.5
    kickUnderGlowMaterial.opacity = 0.6 + kickBrightness * 0.4
  }, [kickUnderGlowMaterial, kickBrightness])

  useEffect(() => {
    kickFretMaterialDrums.emissiveIntensity = 0.8 + kickBrightness * 1.2
  }, [kickFretMaterialDrums, kickBrightness])

  useEffect(() => {
    kickFlashMat.opacity = kickBrightness * 0.5
  }, [kickFlashMat, kickBrightness])

  useEffect(() => {
    profile.notes.forEach((_, i) => {
      const pressed = pressedLanes.find((p) => p.index === i)
      const brightness = pressed?.brightness ?? 0
      const mat = laneGlowMaterials[i]
      if (mat) {
        mat.opacity = brightness * 0.4
      }
    })
  }, [laneGlowMaterials, pressedLanes, profile.notes])

  // Safely dispose of memoized GPU materials and geometries on unmount
  useEffect(() => {
    return () => {
      simplifiedGlowMaterial.dispose()
      kickUnderGlowMaterial.dispose()
      kickFretMaterialDrums.dispose()
      kickFretMaterialNonDrums.dispose()
      laneGlowMaterials.forEach((m) => m.dispose())
      laneGlowGeo.dispose()
      kickFlashGeo.dispose()
      kickFlashMat.dispose()
    }
  }, [simplifiedGlowMaterial, kickUnderGlowMaterial, kickFretMaterialDrums, kickFretMaterialNonDrums, laneGlowMaterials, laneGlowGeo, kickFlashGeo, kickFlashMat])

  return (
    <group position={[offsetX, 0, 0]}>
      {/* Base bars */}
      <mesh position={[0, 0.015, STRIKE_LINE_POS]} geometry={strikelineBaseGeo} material={strikelineBaseMaterial} />
      <mesh position={[0, 0.035, STRIKE_LINE_POS - 0.01]} rotation={[0.15, 0, 0]} geometry={strikelineGlowBarGeo} material={strikelineGlowBarMaterial} />
      <mesh position={[0, 0.001, STRIKE_LINE_POS + 0.08]} geometry={strikelineUnderGlowGeo} material={strikelineUnderGlowMaterial} />

      {/* Glow under pressed lanes */}
      {!isProKeys && !isVocals && profile.notes.map((_, i) => {
        const x = getFretX(i, laneCount)
        const pressed = pressedLanes.find((p) => p.index === i)
        const brightness = pressed?.brightness ?? 0
        return brightness > 0 ? (
          <mesh key={`glow-${i}`} position={[x, 0.002, STRIKE_LINE_POS]} geometry={laneGlowGeo} material={laneGlowMaterials[i]} />
        ) : null
      })}

      {/* Individual fret pads — not for proKeys/vocals (too many lanes) */}
      {!isProKeys && !isVocals && profile.notes.map((color, i) => {
        const x = getFretX(i, laneCount)
        const pressed = pressedLanes.find((p) => p.index === i)
        return (
          <FretPad
            key={i}
            x={x}
            color={color}
            innerColor={profile.fretInner[i]}
            isPressed={!!pressed}
            pressBrightness={pressed?.brightness ?? 0}
            isDrum={isDrum}
            laneWidth={laneWidth}
          />
        )
      })}

      {/* ProKeys/Vocals: simplified strikeline glow bar instead of individual pads */}
      {(isProKeys || isVocals) && (
        <mesh position={[0, 0.02, STRIKE_LINE_POS]} geometry={simplifiedStrikelineGlowGeo} material={simplifiedGlowMaterial} />
      )}

      {/* Drum-specific elements */}
      {isDrum && (
        <>
          <mesh position={[0, 0.002, STRIKE_LINE_POS + 0.2]} geometry={drumKickGlowGeo} material={kickUnderGlowMaterial} />
          {kickBrightness > 0 && (
            <mesh position={[0, 0.003, STRIKE_LINE_POS + 0.2]} geometry={kickFlashGeo} material={kickFlashMat} />
          )}
          {[-1, 1].map((side) => (
            <group key={side} position={[side * (TRACK_WIDTH / 2 + 0.0152), 0.01, STRIKE_LINE_POS]} scale={[side * 0.5442, 0.5442, 0.5442]} rotation={[-Math.PI / 2, 0, 0]}>
              {assets?.kickFretMeshes?.map((m, i) => (
                <mesh key={i} geometry={m.geometry} material={kickFretMaterialDrums} />
              ))}
            </group>
          ))}
        </>
      )}

      {/* Non-drum kick decorations */}
      {!isDrum && (
        <>
          {[-1, 1].map((side) => (
            <group key={side} position={[side * (TRACK_WIDTH / 2 + 0.0152), 0.01, STRIKE_LINE_POS]} scale={[side * 0.5442, 0.5442, 0.5442]} rotation={[-Math.PI / 2, 0, 0]}>
              {assets?.kickFretMeshes?.map((m, i) => (
                <mesh key={i} geometry={m.geometry} material={kickFretMaterialNonDrums} />
              ))}
            </group>
          ))}
        </>
      )}
    </group>
  )
}
