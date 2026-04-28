// Note Gem, Kick Note Bar, and Hit Flash Effect rendering
import * as THREE from 'three'
import { TRACK_WIDTH, STRIKE_LINE_POS } from './constants'
import type { Note } from '../../types'
import type { HighwayAssets } from './types'

// Cached canvas textures for fret number labels (0-22)
const fretTextureCache = new Map<number, THREE.CanvasTexture>()
function getFretTexture(fret: number): THREE.CanvasTexture {
  let tex = fretTextureCache.get(fret)
  if (tex) return tex
  const size = 192
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  // Dark circle background
  ctx.fillStyle = '#000000'
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.44, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  // White border ring
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.44, 0, Math.PI * 2)
  ctx.stroke()
  // Fret number text
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `bold ${size * 0.52}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(fret), size / 2, size / 2 + 2)
  tex = new THREE.CanvasTexture(canvas)
  fretTextureCache.set(fret, tex)
  return tex
}

export function NoteGem({
  position,
  color,
  isSelected,
  sustainLength,
  sustainOffset: _sustainOffset = 0,
  noteFlags,
  isHeadVisible = true,
  assets,
  isCymbal = false,
  fretNumber
}: {
  position: [number, number, number]
  color: string
  isSelected: boolean
  sustainLength: number
  sustainOffset?: number
  noteFlags?: Note['flags']
  isHeadVisible?: boolean
  assets: HighwayAssets | null
  isCymbal?: boolean
  fretNumber?: number
}): React.JSX.Element {
  const isTap = noteFlags?.isTap
  const isHOPO = noteFlags?.isHOPO
  const isGhost = noteFlags?.isGhost
  const isAccent = noteFlags?.isAccent

  let geometry: THREE.BufferGeometry | undefined
  if (assets) {
    if (isCymbal) geometry = assets.cymbalGeo
    else if (isTap) geometry = assets.tapGeo
    else if (isHOPO) geometry = assets.hopoGeo
    else if (isGhost) geometry = assets.ghostGeo
    else if (isAccent) geometry = assets.accentGeo
    else geometry = assets.noteGeo
  }

  const noteHeightScale = isGhost ? 0.8 : isAccent ? 1.2 : 1.0

  // Sustain bar: when head is visible, trail behind the head.
  // When head is hit (burning), the group is at strike line — trail extends forward into highway.
  const sustainZ = isHeadVisible
    ? -sustainLength / 2 - 0.12
    : -sustainLength / 2

  // Burn edge: bright glow at the strike-line end of an active sustain
  const isBurning = !isHeadVisible && sustainLength > 0

  return (
    <group position={position} scale={[1, noteHeightScale, 1]}>
      {isHeadVisible && (
        <mesh geometry={geometry}>
          {!geometry && <boxGeometry args={[0.34, 0.06, 0.2]} />}
          <meshStandardMaterial
            color={color}
            map={assets?.noteMap ?? null}
            emissive={isSelected ? '#FFFFFF' : color}
            emissiveMap={isSelected ? null : (assets?.noteEmission ?? null)}
            emissiveIntensity={isSelected ? 3.0 : 1.0}
            metalness={0.7}
            roughness={0.15}
            transparent={!!isGhost}
            opacity={isGhost ? 0.5 : 1}
            toneMapped={false}
          />
        </mesh>
      )}
      {/* Selection ring around note head */}
      {isHeadVisible && isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.2, 0.26, 16]} />
          <meshBasicMaterial color="#FFFFFF" transparent opacity={0.7} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      )}

      {/* Fret number for pro guitar/bass */}
      {isHeadVisible && fretNumber !== undefined && (
        <sprite position={[0, 0.22, 0.05]} scale={[0.42, 0.42, 1]}>
          <spriteMaterial map={getFretTexture(fretNumber)} transparent depthWrite={false} sizeAttenuation />
        </sprite>
      )}

      {sustainLength > 0 && (
        <mesh position={[0, 0.03, sustainZ]}>
          <boxGeometry args={[0.1, 0.04, sustainLength]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={isBurning ? 0.9 : 0.7}
            transparent
            opacity={0.9}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* Burn edge glow at the strike-line end of an active sustain */}
      {isBurning && (
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[0.18, 0.08, 0.06]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.45}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  )
}

export function KickNoteBar({
  z,
  color,
  assets,
  isSelected = false,
  sustainLength = 0,
  isSustainActive = false
}: {
  z: number
  color: string
  assets: HighwayAssets | null
  isSelected?: boolean
  sustainLength?: number
  isSustainActive?: boolean
}): React.JSX.Element {
  // Sustain trail: narrower translucent bar extending behind (or forward when active)
  const hasSustain = sustainLength > 0
  const sustainBarWidth = 0.8 // fraction of track width
  const sustainScaleX = (TRACK_WIDTH * sustainBarWidth) / 3.27
  // Trail extends from bar center toward back of highway (negative Z direction in world space)
  const trailZ = isSustainActive ? -sustainLength / 2 : -sustainLength / 2 - 0.075

  return (
    <group position={[0, 0.01, z]} scale={[TRACK_WIDTH / 3.27, 1, 1]}>
      {/* Sustain trail */}
      {hasSustain && (
        <group scale={[sustainScaleX / (TRACK_WIDTH / 3.27), 1, 1]} position={[0, 0, trailZ]}>
          <mesh>
            <boxGeometry args={[3.27, 0.04, sustainLength]} />
            <meshBasicMaterial color={color} transparent opacity={0.3} toneMapped={false} />
          </mesh>
        </group>
      )}
      {/* Bar head */}
      <mesh geometry={assets?.kickGeo ?? undefined}>
        {!assets?.kickGeo && <boxGeometry args={[3.27, 0.06, 0.15]} />}
        <meshStandardMaterial
          color={color}
          map={assets?.kickMap ?? null}
          emissive={isSelected ? '#FFFFFF' : color}
          emissiveIntensity={isSelected ? 3.0 : 1.2}
          metalness={0.5}
          roughness={0.3}
          toneMapped={false}
        />
      </mesh>
      {isSelected && (
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[3.4, 0.02, 0.22]} />
          <meshBasicMaterial color="#FFFFFF" transparent opacity={0.5} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}

export function HitFlashEffect({
  x,
  color,
  progress,
  offsetX
}: {
  x: number
  color: string
  progress: number
  offsetX: number
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(1, progress))
  const visible = clamped < 1

  const flashScale = 0.3 + clamped * 1.2
  const flashOpacity = Math.max(0, (1 - clamped) * 0.8)
  const ringScale = 0.2 + clamped * 1.6
  const ringOpacity = Math.max(0, (1 - clamped) * 0.5)
  const particleY = clamped * 0.6

  return (
    <group position={[offsetX + x, 0, STRIKE_LINE_POS]} visible={visible}>
      <mesh position={[0, 0.06, 0]} scale={[flashScale, flashScale, flashScale]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={flashOpacity} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[ringScale, ringScale, 1]}>
        <ringGeometry args={[0.06, 0.10, 16]} />
        <meshBasicMaterial color={color} transparent opacity={ringOpacity} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      {[0, 1, 2, 3].map((i) => {
        const angle = (i / 4) * Math.PI * 2 + clamped * 2
        const dist = clamped * 0.25
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, 0.04 + particleY, Math.sin(angle) * dist]}
            scale={[1 - clamped, 1 - clamped, 1 - clamped]}
          >
            <boxGeometry args={[0.02, 0.02, 0.02]} />
            <meshBasicMaterial color={color} transparent opacity={flashOpacity * 0.7} depthWrite={false} toneMapped={false} />
          </mesh>
        )
      })}
    </group>
  )
}
