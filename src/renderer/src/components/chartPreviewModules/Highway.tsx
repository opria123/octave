// Highway Surface - YARG Track.shadergraph recreation
import { useMemo, useRef, useContext } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { TRACK_WIDTH, STRIKE_LINE_POS, HIGHWAY_LENGTH, COLORS, getLaneConfig, isBlackKey, PRO_KEYS_MIN, PRO_KEYS_VISIBLE } from './constants'
import type { InstrumentRenderType } from './constants'
import { YARGAssetsContext } from './YARGAssetProvider'

export function Highway({
  instrumentType,
  offsetX = 0,
  currentTick,
  pixelsPerTick,
  proKeysViewStart
}: {
  instrumentType: InstrumentRenderType
  offsetX?: number
  currentTick: number
  pixelsPerTick: number
  proKeysViewStart?: number
}): React.JSX.Element {
  const highwayCenterZ = STRIKE_LINE_POS - HIGHWAY_LENGTH / 2
  const { laneCount } = getLaneConfig(instrumentType)
  const isProKeys = instrumentType === 'proKeys'
  const isVocals = instrumentType === 'vocals'
  // For proKeys/vocals, skip shader lane lines — we draw overlays instead
  const shaderLaneCount = (isProKeys || isVocals) ? 1 : laneCount
  const assets = useContext(YARGAssetsContext)
  const shaderRef = useRef<THREE.ShaderMaterial>(null)

  const highwayMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: true,
        uniforms: {
          baseColor: { value: new THREE.Color(COLORS.trackBase) },
          lineColor: { value: new THREE.Color(COLORS.trackLine) },
          edgeColor: { value: new THREE.Color(COLORS.trackEdge) },
          scroll: { value: 0.0 },
          sidePattern: { value: assets?.sidePattern ?? null }
        },
        vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
        fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 lineColor;
        uniform vec3 edgeColor;
        uniform float scroll;
        uniform sampler2D sidePattern;
        varying vec2 vUv;
        void main() {
          float fade = smoothstep(0.0, 0.15, vUv.y);
          vec3 col = baseColor;
          float lineV = fract(vUv.y * 40.0 + scroll * 2.0);
          float line = smoothstep(0.48, 0.5, lineV) * smoothstep(0.52, 0.5, lineV);
          col = mix(col, lineColor, line * 0.15);
          float edgeDist = abs(vUv.x - 0.5) * 2.0;
          float edgeMask = smoothstep(0.7, 1.0, edgeDist);
          vec2 patternUV = vec2(edgeDist * 2.0, vUv.y * 8.0 + scroll);
          vec4 pattern = texture2D(sidePattern, patternUV);
          col = mix(col, edgeColor * pattern.rgb, edgeMask * 0.6);
          for (int i = 1; i < 6; i++) {
            float laneX = float(i) / float(${shaderLaneCount});
            float laneDist = abs(vUv.x - laneX);
            float laneLine = 1.0 - smoothstep(0.001, 0.004, laneDist);
            col = mix(col, vec3(0.12, 0.12, 0.22), laneLine * 0.5);
          }
          gl_FragColor = vec4(col, fade * 0.97);
        }
      `
      }),
    [assets?.sidePattern, shaderLaneCount]
  )

  useFrame(() => {
    if (shaderRef.current) {
      const scrollVal = (currentTick * pixelsPerTick) / 4.0
      shaderRef.current.uniforms.scroll.value = scrollVal
    }
  })

  const trimX = 1.015

  return (
    <group position={[offsetX, 0, 0]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.001, highwayCenterZ]}
        ref={(mesh) => {
          if (mesh && !shaderRef.current) {
            shaderRef.current = mesh.material as THREE.ShaderMaterial
          }
        }}
        material={highwayMaterial}
      >
        <planeGeometry args={[TRACK_WIDTH + 0.1, HIGHWAY_LENGTH]} />
      </mesh>

      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * trimX, 0.02, highwayCenterZ]}>
            <boxGeometry args={[0.06, 0.05, HIGHWAY_LENGTH]} />
            <meshStandardMaterial
              map={assets?.trackTrimMap ?? null}
              color="#888899"
              metalness={0.8}
              roughness={0.25}
            />
          </mesh>
          <mesh position={[side * trimX, 0.048, highwayCenterZ]}>
            <boxGeometry args={[0.065, 0.006, HIGHWAY_LENGTH]} />
            <meshStandardMaterial
              color="#AAAACC"
              emissive="#334466"
              emissiveIntensity={0.4}
              metalness={0.9}
              roughness={0.2}
            />
          </mesh>
          <mesh position={[side * (trimX - side * 0.025), 0.01, highwayCenterZ]}>
            <boxGeometry args={[0.015, 0.025, HIGHWAY_LENGTH]} />
            <meshStandardMaterial
              color="#2244AA"
              emissive="#3366DD"
              emissiveIntensity={0.6}
              transparent
              opacity={0.7}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Pro Keys: white/black key lane dividers (sliding viewport) */}
      {isProKeys && Array.from({ length: laneCount }, (_, i) => {
        const x = (TRACK_WIDTH / laneCount) * i - TRACK_WIDTH / 2 + TRACK_WIDTH / (2 * laneCount)
        const w = TRACK_WIDTH / laneCount
        const viewBase = proKeysViewStart ?? PRO_KEYS_MIN
        const black = isBlackKey(viewBase + i)
        return (
          <mesh key={`pk-${i}`} position={[x, 0.0005, highwayCenterZ]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w - 0.01, HIGHWAY_LENGTH]} />
            <meshBasicMaterial
              color={black ? '#0A0A14' : '#1A1A28'}
              transparent
              opacity={black ? 0.6 : 0.25}
              depthWrite={false}
            />
          </mesh>
        )
      })}
      {/* Pro Keys: C note markers (octave boundaries) within viewport */}
      {isProKeys && (() => {
        const viewBase = proKeysViewStart ?? PRO_KEYS_MIN
        const markers: React.JSX.Element[] = []
        for (let pitch = viewBase; pitch < viewBase + PRO_KEYS_VISIBLE; pitch++) {
          if (pitch % 12 === 0) { // C notes
            const laneIdx = pitch - viewBase
            const x = (TRACK_WIDTH / laneCount) * laneIdx - TRACK_WIDTH / 2
            markers.push(
              <mesh key={`pk-c-${pitch}`} position={[x, 0.001, highwayCenterZ]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.02, HIGHWAY_LENGTH]} />
                <meshBasicMaterial color="#A78BFA" transparent opacity={0.5} depthWrite={false} />
              </mesh>
            )
          }
        }
        return markers
      })()}

      {/* Vocals: pitch grid lines (every 6 semitones) */}
      {isVocals && Array.from({ length: 5 }, (_, i) => {
        const frac = (i + 1) / 6
        const x = frac * TRACK_WIDTH - TRACK_WIDTH / 2
        return (
          <mesh key={`vg-${i}`} position={[x, 0.001, highwayCenterZ]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.01, HIGHWAY_LENGTH]} />
            <meshBasicMaterial color="#E879F9" transparent opacity={0.2} depthWrite={false} />
          </mesh>
        )
      })}
    </group>
  )
}
