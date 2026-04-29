import type {
  VenueTrackData,
  VenueLightingEvent,
  VenuePostProcessingEvent,
  VenueStageEvent,
  VenueCameraCutEvent,
  VenuePerformerEvent
} from '../../types'
import {
  normalizeVenueLightingEvent,
  normalizeVenuePostProcessingEvent,
  normalizeVenueStageEvent,
  normalizeVenueCameraCutEvent,
  normalizeVenuePerformerEvent,
  type VenueLightingSemantic,
  type VenuePostProcessingSemantic,
  type VenueStageSemantic,
  type VenueCameraSemantic,
  type VenuePerformerSemantic
} from './venueSemantics'

export type VenuePlaybackState = {
  lighting: VenueLightingEvent | null
  lightingSemantic: VenueLightingSemantic | null
  postProcessing: VenuePostProcessingEvent | null
  postProcessingSemantic: VenuePostProcessingSemantic | null
  cameraCut: VenueCameraCutEvent | null
  cameraCutSemantic: VenueCameraSemantic | null
  activeStage: VenueStageEvent[]
  activeStageSemantics: VenueStageSemantic[]
  activePerformer: VenuePerformerEvent[]
  activePerformerSemantics: VenuePerformerSemantic[]
  nextEventTick: number | null
}

export type VenueVisualState = {
  ambientColor: string
  ambientIntensity: number
  keyLightColor: string
  keyLightIntensity: number
  accentColor: string
  accentIntensity: number
  bloomIntensity: number
  cameraXOffset: number
  cameraHeightOffset: number
  cameraDistanceOffset: number
  cameraFovOffset: number
  cssFilter: string
}

const DEFAULT_STAGE_EVENT_DURATION = 480

function byTickAsc<T extends { tick: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => a.tick - b.tick)
}

function latestAtOrBefore<T extends { tick: number }>(events: T[], currentTick: number): T | null {
  const sorted = byTickAsc(events)
  let latest: T | null = null
  for (const event of sorted) {
    if (event.tick <= currentTick) latest = event
    else break
  }
  return latest
}

export function resolveVenuePlaybackState(venueTrack: VenueTrackData, currentTick: number): VenuePlaybackState {
  const lighting = latestAtOrBefore(venueTrack.lighting, currentTick)
  const postProcessing = latestAtOrBefore(venueTrack.postProcessing, currentTick)
  const cameraCut = latestAtOrBefore(venueTrack.cameraCuts, currentTick)

  const activeStage = byTickAsc(venueTrack.stage).filter((event) => {
    const duration = Math.max(1, event.duration ?? DEFAULT_STAGE_EVENT_DURATION)
    return currentTick >= event.tick && currentTick < event.tick + duration
  })

  const activePerformer = byTickAsc(venueTrack.performer).filter((event) => {
    const duration = Math.max(1, event.duration)
    return currentTick >= event.tick && currentTick < event.tick + duration
  })

  const allTicks = [
    ...venueTrack.lighting.map((event) => event.tick),
    ...venueTrack.postProcessing.map((event) => event.tick),
    ...venueTrack.stage.map((event) => event.tick),
    ...venueTrack.cameraCuts.map((event) => event.tick),
    ...venueTrack.performer.map((event) => event.tick)
  ]

  const nextEventTick = allTicks.filter((tick) => tick > currentTick).sort((a, b) => a - b)[0] ?? null

  return {
    lighting,
    lightingSemantic: normalizeVenueLightingEvent(lighting),
    postProcessing,
    postProcessingSemantic: normalizeVenuePostProcessingEvent(postProcessing),
    cameraCut,
    cameraCutSemantic: normalizeVenueCameraCutEvent(cameraCut),
    activeStage,
    activeStageSemantics: activeStage.map(normalizeVenueStageEvent),
    activePerformer,
    activePerformerSemantics: activePerformer.map(normalizeVenuePerformerEvent),
    nextEventTick
  }
}

export function resolveVenueVisualState(state: VenuePlaybackState): VenueVisualState {
  let ambientColor = '#182238'
  let ambientIntensity = 0.3
  let keyLightColor = '#FFFFFF'
  let keyLightIntensity = 0.5
  let accentColor = '#3366CC'
  let accentIntensity = 0.6
  let bloomIntensity = 1.2
  let cameraXOffset = 0
  let cameraHeightOffset = 0
  let cameraDistanceOffset = 0
  let cameraFovOffset = 0
  let cssFilter = 'none'

  const lightingMood = state.lightingSemantic?.mood ?? 'neutral'
  if (lightingMood === 'blackout') {
    ambientColor = '#07090e'
    ambientIntensity = 0.1
    keyLightIntensity = 0.2
    accentIntensity = 0.25
    bloomIntensity = 0.35
  } else if (lightingMood === 'strobe') {
    ambientColor = '#24344f'
    ambientIntensity = 0.5
    keyLightIntensity = 0.9
    accentIntensity = 1.0
    bloomIntensity = 1.9
  } else if (lightingMood === 'warm') {
    ambientColor = '#3b2a1f'
    keyLightColor = '#FFD5A0'
    accentColor = '#FF9850'
    ambientIntensity = 0.4
    keyLightIntensity = 0.75
    accentIntensity = 0.8
    bloomIntensity = 1.6
  } else if (lightingMood === 'cool') {
    ambientColor = '#172840'
    keyLightColor = '#B6D8FF'
    accentColor = '#5FA8FF'
    ambientIntensity = 0.34
    keyLightIntensity = 0.68
    accentIntensity = 0.72
    bloomIntensity = 1.35
  }

  const postFx = state.postProcessingSemantic?.effect ?? 'none'
  if (postFx === 'bloom') {
    bloomIntensity += 0.45
    cssFilter = 'saturate(1.08) brightness(1.08) contrast(1.04)'
  } else if (postFx === 'negative') {
    cssFilter = 'invert(1) hue-rotate(180deg)'
  } else if (postFx === 'sepia') {
    cssFilter = 'sepia(0.72) saturate(1.1)'
  } else if (postFx === 'desaturate') {
    cssFilter = 'grayscale(0.88) contrast(1.1)'
  } else if (postFx === 'posterize') {
    cssFilter = 'contrast(1.35) saturate(0.75)'
  } else if (postFx === 'security_cam') {
    cssFilter = 'contrast(1.2) saturate(0.72) brightness(0.95)'
  }

  const cameraTarget = state.cameraCutSemantic?.target ?? 'other'
  const cameraFraming = state.cameraCutSemantic?.framing ?? 'default'
  if (cameraTarget === 'guitar') cameraXOffset = -0.7
  else if (cameraTarget === 'bass') cameraXOffset = 0.65
  else if (cameraTarget === 'drums') {
    cameraXOffset = 0.25
    cameraDistanceOffset = -0.7
  } else if (cameraTarget === 'vocals') {
    cameraXOffset = -0.15
    cameraDistanceOffset = -0.55
    cameraHeightOffset = 0.25
  } else if (cameraTarget === 'keys') cameraXOffset = 0.85

  if (cameraFraming === 'wide') {
    cameraDistanceOffset = 1.6
    cameraFovOffset = -3
  } else if (cameraFraming === 'near' || cameraFraming === 'closeup') {
    cameraDistanceOffset = -1.15
    cameraFovOffset = 4
  }

  if (state.activePerformerSemantics.length > 0) {
    keyLightIntensity += 0.12
    bloomIntensity += 0.2
  }

  if (state.activeStageSemantics.some((event) => event.effect === 'fog_on')) {
    ambientIntensity *= 0.92
    keyLightIntensity *= 0.9
  }

  return {
    ambientColor,
    ambientIntensity,
    keyLightColor,
    keyLightIntensity,
    accentColor,
    accentIntensity,
    bloomIntensity,
    cameraXOffset,
    cameraHeightOffset,
    cameraDistanceOffset,
    cameraFovOffset,
    cssFilter
  }
}
