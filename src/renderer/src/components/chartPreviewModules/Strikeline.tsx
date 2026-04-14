// Strikeline and Fret Pads - YARG RectangularFret.prefab recreation
import { useMemo, useRef, useContext } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  TRACK_WIDTH, STRIKE_LINE_POS, COLORS, DRUM_KICK_COLOR,
  DRUM_FRET_SCALE_X, GUITAR_FRET_SCALE_X, FRET_INACTIVE_COLOR,
  getLaneConfig, getFretX, PRO_KEYS_COLOR, VOCAL_COLOR
} from './constants'
import type { InstrumentRenderType } from './constants'
import { YARGAssetsContext } from './YARGAssetProvider'

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
  const assets = useContext(YARGAssetsContext)
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

  const outerMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: activeOuterColor,
        emissive: new THREE.Color(isPressed ? color : '#111111'),
        emissiveIntensity: outerEmissiveIntensity,
        map: assets?.fretMap ?? null,
        metalness: 0.5,
        roughness: 0.3,
        toneMapped: false
      }),
    [activeOuterColor, isPressed, color, outerEmissiveIntensity, assets?.fretMap]
  )

  const innerMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: activeInnerColor,
        emissive: new THREE.Color(isPressed ? innerColor : '#080808'),
        emissiveIntensity: innerEmissiveIntensity,
        metalness: 0.6,
        roughness: 0.35
      }),
    [activeInnerColor, isPressed, innerColor, innerEmissiveIntensity]
  )

  const metalMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#888899',
        metalness: 0.85,
        roughness: 0.2
      }),
    []
  )

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
          <mesh>
            <boxGeometry args={[laneWidth * 0.85, 0.03, laneWidth * 0.55]} />
            <meshStandardMaterial
              color={activeInnerColor}
              emissive={isPressed ? innerColor : '#080808'}
              emissiveIntensity={innerEmissiveIntensity}
              metalness={0.6}
              roughness={0.35}
            />
          </mesh>
          <mesh position={[0, 0.02, 0]}>
            <boxGeometry args={[laneWidth * 0.82, 0.008, laneWidth * 0.52]} />
            <meshStandardMaterial
              color={activeOuterColor}
              emissive={isPressed ? color : '#111111'}
              emissiveIntensity={outerEmissiveIntensity}
              toneMapped={false}
            />
          </mesh>
        </>
      )}
      {isPressed && (
        <mesh position={[0, 0.04, 0]}>
          <sphereGeometry args={[0.1, 12, 12]} />
          <meshBasicMaterial color={color} transparent opacity={0.3 * pressBrightness} toneMapped={false} />
        </mesh>
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
  const assets = useContext(YARGAssetsContext)

  return (
    <group position={[offsetX, 0, 0]}>
      <mesh position={[0, 0.015, STRIKE_LINE_POS]}>
        <boxGeometry args={[TRACK_WIDTH + 0.14, 0.035, 0.06]} />
        <meshStandardMaterial color="#1a1a2e" metalness={0.7} roughness={0.3} />
      </mesh>

      <mesh position={[0, 0.035, STRIKE_LINE_POS - 0.01]} rotation={[0.15, 0, 0]}>
        <boxGeometry args={[TRACK_WIDTH + 0.14, 0.008, 0.025]} />
        <meshStandardMaterial
          color="#FFFFFF"
          emissive="#4466CC"
          emissiveIntensity={1.5}
          metalness={0.9}
          roughness={0.1}
          toneMapped={false}
        />
      </mesh>

      <mesh position={[0, 0.001, STRIKE_LINE_POS + 0.08]}>
        <boxGeometry args={[TRACK_WIDTH, 0.002, 0.16]} />
        <meshBasicMaterial color="#2244AA" transparent opacity={0.15} toneMapped={false} />
      </mesh>

      {/* Glow under pressed lanes */}
      {!isProKeys && !isVocals && profile.notes.map((color, i) => {
        const x = getFretX(i, laneCount)
        const pressed = pressedLanes.find((p) => p.index === i)
        const brightness = pressed?.brightness ?? 0
        return brightness > 0 ? (
          <mesh key={`glow-${i}`} position={[x, 0.002, STRIKE_LINE_POS]}>
            <boxGeometry args={[laneWidth * 0.9, 0.003, 0.25]} />
            <meshBasicMaterial color={color} transparent opacity={brightness * 0.4} toneMapped={false} />
          </mesh>
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
        <mesh position={[0, 0.02, STRIKE_LINE_POS]}>
          <boxGeometry args={[TRACK_WIDTH * 0.96, 0.025, 0.12]} />
          <meshStandardMaterial
            color={isProKeys ? PRO_KEYS_COLOR : VOCAL_COLOR}
            emissive={isProKeys ? PRO_KEYS_COLOR : VOCAL_COLOR}
            emissiveIntensity={0.6}
            transparent
            opacity={0.5}
            toneMapped={false}
          />
        </mesh>
      )}

      {isDrum && (() => {
        const kickPress = pressedLanes.find((p) => p.index === -1)
        const kickBrightness = kickPress?.brightness ?? 0
        return (
        <>
          <mesh position={[0, 0.002, STRIKE_LINE_POS + 0.2]}>
            <boxGeometry args={[TRACK_WIDTH * 0.95, 0.008, 0.08]} />
            <meshStandardMaterial
              color={DRUM_KICK_COLOR}
              emissive={DRUM_KICK_COLOR}
              emissiveIntensity={0.5 + kickBrightness * 1.5}
              transparent
              opacity={0.6 + kickBrightness * 0.4}
              toneMapped={false}
            />
          </mesh>
          {kickBrightness > 0 && (
            <mesh position={[0, 0.003, STRIKE_LINE_POS + 0.2]}>
              <boxGeometry args={[TRACK_WIDTH, 0.004, 0.16]} />
              <meshBasicMaterial color={DRUM_KICK_COLOR} transparent opacity={kickBrightness * 0.5} depthWrite={false} toneMapped={false} />
            </mesh>
          )}
          {[-1, 1].map((side) => (
            <group key={side} position={[side * (TRACK_WIDTH / 2 + 0.0152), 0.01, STRIKE_LINE_POS]} scale={[side * 0.5442, 0.5442, 0.5442]} rotation={[-Math.PI / 2, 0, 0]}>
              {assets?.kickFretMeshes?.map((m, i) => (
                <mesh key={i} geometry={m.geometry}>
                  <meshStandardMaterial
                    color={DRUM_KICK_COLOR}
                    emissive={DRUM_KICK_COLOR}
                    emissiveIntensity={0.8 + kickBrightness * 1.2}
                    map={assets?.kickFretMap ?? null}
                    metalness={0.5}
                    roughness={0.3}
                    toneMapped={false}
                  />
                </mesh>
              ))}
            </group>
          ))}
        </>
        )
      })()}

      {!isDrum && (
        <>
          {[-1, 1].map((side) => (
            <group key={side} position={[side * (TRACK_WIDTH / 2 + 0.0152), 0.01, STRIKE_LINE_POS]} scale={[side * 0.5442, 0.5442, 0.5442]} rotation={[-Math.PI / 2, 0, 0]}>
              {assets?.kickFretMeshes?.map((m, i) => (
                <mesh key={i} geometry={m.geometry}>
                  <meshStandardMaterial
                    color="#9933FF"
                    emissive="#6622AA"
                    emissiveIntensity={0.5}
                    map={assets?.kickFretMap ?? null}
                    metalness={0.5}
                    roughness={0.3}
                  />
                </mesh>
              ))}
            </group>
          ))}
        </>
      )}
    </group>
  )
}
